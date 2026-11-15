import { Bot, InputFile } from 'grammy';
import { config, webappUrl, gmailEnabled } from './config.js';
import * as store from './store.js';
import {
  btn, rows, head, HR, mailCard, mailKeyboard, fullMessageText,
  genCard, genKeyboard, totpVaultView, fmtTime, formatOtpSpaced,
} from './ui.js';
import { escapeHtml as esc } from './lib/mailparse.js';
import { safeSend, sendBotPhoto, initNotify } from './notify.js';
import { startAuto2faJob, performAuto2faAction, getActiveJobForUser, registerAuto2faBotHook } from './auto2faEngine.js';
import { gmailAuthUrl } from './gmail.js';
import { startSingleImap, titanStatus } from './titan.js';

const startedAt = Date.now();
const pending = new Map();
const lastGenCmdMsg = new Map(); // userId -> messageId of previous /gen or button tap

const delUserMsg = async (ctx) => {
  try {
    if (ctx.message?.message_id && ctx.chat?.id) {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
    }
  } catch {}
};

registerAuto2faBotHook((uid, jobId, status) => {
  const numId = Number(uid);
  if (jobId && (status === 'waiting_code' || status === 'waiting_captcha' || status === 'waiting_approval')) {
    pending.set(numId, { type: 'a2fa_input', jobId });
  } else if (!jobId || status === 'completed' || status === 'failed') {
    if (pending.get(numId)?.type === 'a2fa_input') pending.delete(numId);
  }
});

const isAdmin = (id) => String(id) === config.adminId;
const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const cleanName = (s = '') => s.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);

function pickDomain(userId) {
  const u = store.getUser(userId);
  const pref = typeof u?.prefDomain === 'number' ? u.prefDomain : -1;
  if (pref === -1) return 'random';
  return config.domains[pref % config.domains.length] || 'random';
}

function makeAddress(owner, domain = '', local = '', ttl = 0) {
  const dom = domain || pickDomain(owner);
  return store.generateUniqueAddress(owner, local, '', ttl, dom);
}

const mainMenu = (admin) => {
  const row1 = [{ text: '⚡ Instant Mail', style: 'success' }, { text: '🎯 Custom', style: 'primary' }];
  const keyboard = admin ? [row1, [{ text: '👑 Admin', style: 'danger' }]] : [row1];
  return {
    keyboard,
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: '⚡ Instant Mail বা 🎯 Custom ট্যাপ করুন',
  };
};

async function delPrompt(ctx, p) {
  try {
    if (p?.promptMsgId && ctx.chat?.id) {
      await ctx.api.deleteMessage(ctx.chat.id, p.promptMsgId);
    }
  } catch {}
}

async function edit(ctx, text, markup, addr = '') {
  try {
    const r = await ctx.editMessageText(text, { ...HTML, reply_markup: markup });
    if (r?.message_id && ctx.from && addr) {
      store.setActiveCard(ctx.from.id, ctx.chat?.id || ctx.from.id, r.message_id, addr, false);
    }
  } catch (e) {
    if (!/not modified/i.test(e.description || e.message || '')) {
      const prev = ctx.from && store.getActiveCard(ctx.from.id);
      if (prev?.chatId && prev?.messageId && !prev.gotMail) {
        await ctx.api.deleteMessage(prev.chatId, prev.messageId).catch(() => {});
      }
      const s = await ctx.reply(text, { ...HTML, reply_markup: markup }).catch(() => null);
      if (s && ctx.from && addr) store.setActiveCard(ctx.from.id, s.chat.id, s.message_id, addr, false);
    }
  }
}

export function createBot() {
  const bot = new Bot(config.token);
  initNotify(bot);
  bot.catch((err) => console.error('❌ Bot error:', err.error?.description || err.error?.message || err.message));

  // ---------- inline mode: @bot in any chat ----------
  bot.on('inline_query', async (ctx) => {
    const u = store.getUser(ctx.from.id);
    if (!u || u.status !== 'approved') {
      return ctx.answerInlineQuery([], { cache_time: 5, is_personal: true, button: { text: '🔒 আগে বটে /start দিন', start_parameter: 'start' } }).catch(() => {});
    }
    const q = (ctx.inlineQuery.query || '').trim().toLowerCase();
    const totp = store.listTotp(u.id)
      .filter((t) => !q || `${t.name} ${t.issuer || ''}`.toLowerCase().includes(q))
      .slice(0, 5);
    const codes = store.listMessages(u.id, { limit: 80 })
      .filter((m) => m.otp && (!q || `${m.service?.name || ''} ${m.subject || ''} ${m.to || ''}`.toLowerCase().includes(q)))
      .slice(0, 6);
    const addrs = store.listAddresses(u.id)
      .filter((a) => !a.expired && (!q || a.addr.includes(q) || (a.label || '').toLowerCase().includes(q)))
      .slice(0, 4);

    const results = [
      ...totp.map((t) => ({
        type: 'article',
        id: `2fa_${t.id}`,
        title: `🛡 ${t.name} · ${formatOtpSpaced(t.code)} (${t.remaining}s)`,
        description: `${t.issuer || '2FA Vault'} • ট্যাপ করে পাঠান`,
        input_message_content: { message_text: t.code },
      })),
      ...codes.map((m) => ({
        type: 'article',
        id: `c_${m.id}`,
        title: `🔐 ${m.otp} · ${m.service?.name || 'Mail'}`,
        description: `${m.purpose || ''} • ${fmtTime(m.date)}`,
        input_message_content: { message_text: m.otp },
      })),
      ...addrs.map((a) => ({
        type: 'article',
        id: `a_${a.id}`,
        title: `📧 ${a.addr}`,
        description: a.label || 'অ্যাড্রেস শেয়ার করুন',
        input_message_content: { message_text: a.addr },
      })),
    ].slice(0, 15);

    await ctx.answerInlineQuery(results, {
      cache_time: 0,
      is_personal: true,
      button: results.length ? undefined : { text: '⚡ নতুন মেইল তৈরি করুন', start_parameter: 'gen' },
    }).catch(() => {});
  });

  // ---------- access control ----------
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) return;
    if (ctx.chat && ctx.chat.type !== 'private') return;
    const admin = isAdmin(ctx.from.id);
    const { user, isNew } = store.touchUser(ctx.from, admin || config.openAccess ? 'approved' : 'pending');
    if (admin && user.status !== 'approved') store.setUserStatus(user.id, 'approved');
    if (user.status === 'banned') return;
    if (user.status === 'approved') return next();

    if (isNew && config.adminId) {
      await safeSend(
        config.adminId,
        head('🔔', 'New Access Request') + `👤 <b>${esc(user.name)}</b>${user.username ? ` (@${esc(user.username)})` : ''}\n🆔 <code>${user.id}</code>`,
        rows([btn.cb('✅ Approve', `am:ok:${user.id}`, 'success'), btn.cb('⛔ Reject', `am:no:${user.id}`, 'danger')])
      );
    }
    if (ctx.callbackQuery) return ctx.answerCallbackQuery({ text: '⏳ অ্যাডমিনের অনুমোদনের অপেক্ষায়', show_alert: true }).catch(() => {});
    return ctx.reply('⏳ <b>Your access request is pending admin approval.</b>', HTML);
  });

  bot.on('callback_query:data', async (ctx, next) => {
    const orig = ctx.answerCallbackQuery.bind(ctx);
    ctx.answerCallbackQuery = (...a) => { ctx._answered = true; return orig(...a); };
    await next();
    if (!ctx._answered) await orig().catch(() => {});
  });

  // ---------- /start ----------
  bot.command('start', async (ctx) => {
    pending.delete(ctx.from.id);
    const ex = store.listAddresses(ctx.from.id).find((a) => !a.expired) || makeAddress(ctx.from.id);
    const domLabel = ex.addr.split('@')[1] || config.domains[0];
    const modeLabel = pickDomain(ctx.from.id) === 'random' ? '🎲 Auto' : '';
    const appInline = btn.app('🚀 Launch Mini App', '', 'success');
    await ctx.reply(
      `⚡ <b>${esc(config.brand)} Ready</b>\n` +
      `মিনিমাল ডিসপোজেবল মেইল, ইনস্ট্যান্ট OTP এবং লাইভ 2FA ভল্ট প্রস্তুত।`,
      { ...HTML, reply_markup: mainMenu(isAdmin(ctx.from.id)) }
    ).catch(() => {});
    const s = await ctx.reply(genCard(ex, { domainLabel: domLabel, modeLabel }), {
      ...HTML,
      reply_markup: genKeyboard(ex, { multiDomain: config.domains.length > 1 }),
    }).catch(() => null);
    if (s) store.setActiveCard(ctx.from.id, s.chat.id, s.message_id, ex.addr, false);
    if (!s && appInline) await ctx.reply('📱 Open App:', { reply_markup: rows([appInline]) }).catch(() => {});
  });

  // ---------- quick panel & stats ----------
  async function quickPanel(ctx, asEdit = false) {
    const id = ctx.from.id;
    const live = store.listAddresses(id).filter((x) => !x.expired).length;
    const act = store.activity(id, 12);
    const max = Math.max(1, ...act);
    const bars = act.map((v) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.round((v / max) * 7))]).join('');
    const st = store.countStats(id);
    const tCount = store.listTotp(id).length;
    const gCount = store.listGmail(id).length;
    const text =
      head('📊', 'Workspace Overview') +
      `📮 Active Mails <b>${live}</b>  ·  🔐 2FA Vault <b>${tCount}</b>\n` +
      `📬 Total <b>${st.total}</b>  ·  🔵 Unread <b>${st.unread}</b>  ·  🔑 OTPs <b>${st.otp}</b>\n` +
      `📧 Gmail Sync <b>${gCount}</b>  ·  <code>${bars}</code> <i>12h</i>`;
    const appBtn = btn.app('📱 Open Mini App', '', 'success');
    const markup = rows(
      [btn.cb('⚡ New Mail', 'gn', 'success'), btn.cb('🛡 2FA Vault', 'tf:home', 'success')],
      [btn.cb(`📬 Inbox${st.unread ? ` (${st.unread})` : ''}`, 'ib:0', 'primary'), btn.cb('🔐 OTP Codes', 'cd', 'primary')],
      [btn.cb('📮 Addresses', 'as', 'primary'), btn.cb('📧 Gmail', 'gm', 'primary'), btn.cb('⚙️ Settings', 'st', 'primary')],
      ...(appBtn ? [[appBtn]] : [])
    );
    return asEdit ? edit(ctx, text, markup) : ctx.reply(text, { ...HTML, reply_markup: markup });
  }
  bot.command('stats', (ctx) => quickPanel(ctx));
  bot.callbackQuery('qp', (ctx) => quickPanel(ctx, true));

  // ---------- codes digest (Mail OTPs + 2FA) ----------
  async function codes(ctx, asEdit = false) {
    const mailOtps = store.listMessages(ctx.from.id, { limit: 120, filter: 'otp' }).slice(0, 6);
    const vault = store.listTotp(ctx.from.id).slice(0, 4);
    let body = '';
    if (vault.length) {
      body += `<b>🛡 Live 2FA:</b>\n` + vault.map((v) => `• ${esc(v.name)}: <code>${formatOtpSpaced(v.code)}</code> (${v.remaining}s)`).join('\n') + '\n\n';
    }
    if (mailOtps.length) {
      body += `<b>🔑 Recent Mail OTPs:</b>\nট্যাপ করলেই কপি হবে:`;
    } else if (!vault.length) {
      body += 'এখনো কোনো OTP বা 2FA কোড নেই।';
    }
    const text = head('🔐', 'Live Codes & OTPs') + body;
    const markup = rows(
      ...vault.map((v) => [btn.copy(`🛡 ${v.name.slice(0, 20)} · ${formatOtpSpaced(v.code)}`, v.code, 'success')]),
      ...mailOtps.map((m) => [btn.copy(`${m.service.icon} ${m.service.name} · ${m.otp} · ${fmtTime(m.date)}`.slice(0, 60), m.otp, 'primary')]),
      [btn.cb('🔄 Refresh', 'cd', 'success'), btn.cb('📊 Panel', 'qp', 'primary')]
    );
    return asEdit ? edit(ctx, text, markup) : ctx.reply(text, { ...HTML, reply_markup: markup });
  }
  bot.command('codes', (ctx) => codes(ctx));
  bot.callbackQuery('cd', (ctx) => codes(ctx, true));

  // ---------- TTL controls ----------
  bot.callbackQuery(/^gt:(\w+)$/, async (ctx) => {
    const rec = store.getAddressById(ctx.match[1]);
    if (!rec || rec.owner !== String(ctx.from.id)) return;
    await edit(
      ctx,
      head('⏳', 'মেয়াদ নির্ধারণ করুন') + `<code>${esc(rec.addr)}</code>\nবর্তমান: <b>${rec.ttl ? `${rec.ttl}m` : '♾ Permanent'}</b>`,
      rows(
        [
          btn.cb('♾ Permanent', `tt:${rec.id}:0`, rec.ttl === 0 ? 'success' : 'primary'),
          btn.cb('10m', `tt:${rec.id}:10`, rec.ttl === 10 ? 'success' : 'primary'),
          btn.cb('1h', `tt:${rec.id}:60`, rec.ttl === 60 ? 'success' : 'primary'),
          btn.cb('24h', `tt:${rec.id}:1440`, rec.ttl === 1440 ? 'success' : 'primary'),
        ],
        [btn.cb('➕ +1h Extend', `ex:${rec.id}`, 'success'), btn.cb('⬅️ Back', `gc:${rec.id}`, 'primary')]
      )
    );
  });
  bot.callbackQuery(/^gc:(\w+)$/, async (ctx) => {
    const rec = store.getAddressById(ctx.match[1]);
    if (!rec || rec.owner !== String(ctx.from.id)) return;
    const dom = rec.addr.split('@')[1] || '';
    await edit(ctx, genCard(rec, { domainLabel: dom }), genKeyboard(rec), rec.addr);
  });
  bot.callbackQuery(/^tt:(\w+):(\d+)$/, async (ctx) => {
    const rec = store.getAddressById(ctx.match[1]);
    if (!rec || rec.owner !== String(ctx.from.id)) return;
    const mins = Number(ctx.match[2]);
    if (!store.TTLS.includes(mins)) return;
    const upd = store.setExpiry(rec.id, mins);
    await ctx.answerCallbackQuery({ text: mins ? `⏳ মেয়াদ: ${mins >= 60 ? `${mins / 60} ঘণ্টা` : `${mins} মিনিট`}` : '♾ স্থায়ী মেইল' });
    await edit(ctx, genCard(upd), genKeyboard(upd), upd.addr);
  });
  bot.callbackQuery(/^ex:(\w+)$/, async (ctx) => {
    const rec = store.getAddressById(ctx.match[1]);
    if (!rec || rec.owner !== String(ctx.from.id)) return;
    const upd = store.extendAddress(rec.id, 60);
    await ctx.answerCallbackQuery({ text: '✅ মেয়াদ +১ ঘণ্টা বাড়ানো হয়েছে' });
    await edit(ctx, genCard(upd), genKeyboard(upd), upd.addr);
  });

  // ---------- mute / settings ----------
  const getOwned = (ctx, id) => {
    const m = store.getMessage(id);
    return m && (m.owner === String(ctx.from.id) || isAdmin(ctx.from.id)) ? m : null;
  };
  bot.callbackQuery(/^mu:(\w+)$/, async (ctx) => {
    const m = getOwned(ctx, ctx.match[1]);
    if (!m) return;
    store.setSettings(ctx.from.id, { mute: m.service.name });
    await ctx.answerCallbackQuery({ text: `🔕 ${m.service.name} মিউট হয়েছে`, show_alert: true });
  });
  bot.callbackQuery(/^um:(\d+)$/, async (ctx) => {
    const name = store.getSettings(ctx.from.id).muted[Number(ctx.match[1])];
    if (name) store.setSettings(ctx.from.id, { unmute: name });
    await showSettings(ctx, true);
  });
  bot.callbackQuery(/^st:skin:(\w+)$/, async (ctx) => { store.setSettings(ctx.from.id, { skin: ctx.match[1] }); await showSettings(ctx, true); });
  bot.callbackQuery(/^st:theme:([\w-]+)$/, async (ctx) => { store.setSettings(ctx.from.id, { theme: ctx.match[1] }); await showSettings(ctx, true); });
  bot.callbackQuery(/^st:ttl:(\d+)$/, async (ctx) => { store.setSettings(ctx.from.id, { ttl: Number(ctx.match[1]) }); await showSettings(ctx, true); });

  const onOff = (b) => (b ? '🟢 ON' : '⚪ OFF');
  const TTL_LABEL = { 0: '♾ নেই', 10: '10m', 60: '1h', 1440: '24h' };
  function settingsView(uid) {
    const s = store.getSettings(uid);
    const text = head('⚙️', 'Settings') +
      `🔔 Notifications  <b>${onOff(s.notify)}</b>\n` +
      `🔐 OTP/Link only  <b>${onOff(s.otpOnly)}</b>\n` +
      `⚡ Auto-Copy OTP  <b>${onOff(s.autoCopy)}</b>\n` +
      `🎨 Card style  <b>${s.style}</b>  ·  Skin <b>${s.skin}</b>  ·  Theme <b>${s.theme}</b>\n` +
      `⏳ Default TTL  <b>${TTL_LABEL[s.ttl] || '♾'}</b>  ·  🔕 Muted <b>${s.muted.length}</b>`;
    const appBtn = btn.app('🎨 Appearance Studio', '?tab=settings', 'success');
    const markup = rows(
      [btn.cb(`🔔 Notify: ${s.notify ? 'ON' : 'OFF'}`, 'st:notify', s.notify ? 'success' : 'danger'), btn.cb(`🔐 OTP Only: ${s.otpOnly ? 'ON' : 'OFF'}`, 'st:otp', s.otpOnly ? 'success' : 'primary')],
      [btn.cb(`⚡ Auto-Copy: ${s.autoCopy ? 'ON' : 'OFF'}`, 'st:ac', s.autoCopy ? 'success' : 'primary')],
      ['smart', 'rich', 'compact'].map((x) => btn.cb(`${s.style === x ? '✓ ' : ''}${x}`, `st:style:${x}`, s.style === x ? 'success' : 'primary')),
      store.TTLS.map((m) => btn.cb(`${s.ttl === m ? '✓ ' : ''}${m === 0 ? '♾' : m >= 60 ? `${m / 60}h` : `${m}m`}`, `st:ttl:${m}`, s.ttl === m ? 'success' : 'primary')),
      [{ k: 'glass', l: 'Glass' }, { k: 'claude', l: 'Claude' }, { k: 'mix', l: 'Mix' }].map((x) =>
        btn.cb(`${s.skin === x.k ? '✓ ' : ''}${x.l}`, `st:skin:${x.k}`, s.skin === x.k ? 'success' : 'primary')
      ),
      [
        { k: 'aurora', l: '🌙 Aurora' },
        { k: 'claude', l: '🟠 Claude' },
        { k: 'daylight', l: '☀️ Light' },
        { k: 'claude-light', l: '📜 Cream' },
      ].map((x) => btn.cb(`${s.theme === x.k ? '✓ ' : ''}${x.l}`, `st:theme:${x.k}`, s.theme === x.k ? 'success' : 'primary')),
      ...s.muted.slice(0, 4).map((n, i) => [btn.cb(`🔔 Unmute ${n}`, `um:${i}`, 'danger')]),
      [btn.cb('✅ Mark All Read', 'st:read', 'primary'), btn.cb('🧹 Clear Inbox', 'st:clr', 'danger')],
      [...(appBtn ? [appBtn] : []), btn.cb('⬅️ Panel', 'qp', 'primary')]
    );
    return { text, markup };
  }
  const showSettings = (ctx, asEdit = false) => {
    const v = settingsView(ctx.from.id);
    return asEdit ? edit(ctx, v.text, v.markup) : ctx.reply(v.text, { ...HTML, reply_markup: v.markup });
  };
  bot.command('settings', (ctx) => showSettings(ctx));
  bot.hears('⚙️ Settings', async (ctx) => { await delUserMsg(ctx); return showSettings(ctx); });
  bot.callbackQuery('st', (ctx) => showSettings(ctx, true));
  bot.callbackQuery('st:notify', async (ctx) => { store.setSettings(ctx.from.id, { notify: !store.getSettings(ctx.from.id).notify }); await showSettings(ctx, true); });
  bot.callbackQuery('st:otp', async (ctx) => { store.setSettings(ctx.from.id, { otpOnly: !store.getSettings(ctx.from.id).otpOnly }); await showSettings(ctx, true); });
  bot.callbackQuery('st:ac', async (ctx) => { store.setSettings(ctx.from.id, { autoCopy: !store.getSettings(ctx.from.id).autoCopy }); await showSettings(ctx, true); });
  bot.callbackQuery(/^st:style:(\w+)$/, async (ctx) => { store.setSettings(ctx.from.id, { style: ctx.match[1] }); await showSettings(ctx, true); });
  bot.callbackQuery('st:read', async (ctx) => { const n = store.markAllRead(ctx.from.id); await ctx.answerCallbackQuery({ text: `✅ ${n}টি পঠিত করা হয়েছে` }); });
  bot.callbackQuery('st:clr', (ctx) => edit(ctx, '🧹 <b>ইনবক্সের সব মেসেজ মুছে ফেলবেন?</b>', rows([btn.cb('✅ হ্যাঁ, মুছুন', 'st:clry', 'danger'), btn.cb('↩️ না', 'st', 'success')])));
  bot.callbackQuery('st:clry', async (ctx) => { const n = store.clearMessages(ctx.from.id); await ctx.answerCallbackQuery({ text: `🧹 ${n}টি মুছে গেছে` }); await showSettings(ctx, true); });

  bot.command('myid', (ctx) => ctx.reply(`🆔 Chat ID: <code>${ctx.chat.id}</code>`, HTML));
  bot.command('help', (ctx) => ctx.reply(
    head('💡', `${config.brand} Commands`) +
    `<b>/gen</b> [alias] [@domain] — ইনস্ট্যান্ট বা কাস্টম মেইল\n` +
    `<b>/custom</b> [name] — কাস্টম মেইল তৈরি\n` +
    `<b>/domain</b> — ডোমেইন বা র‍্যান্ডম মোড বদল\n` +
    `<b>/inbox</b> [search] — ইনবক্স ও OTP সার্চ\n` +
    `<b>/codes</b> — সাম্প্রতিক OTP ও 2FA কোড\n` +
    `<b>/2fa</b> — লাইভ 2FA Authenticator Vault\n` +
    `<b>/add2fa</b> &lt;name|secret বা URI&gt; — 2FA যোগ করুন\n` +
    `<b>/gmail</b> — Gmail কানেক্ট ও লাইভ সিঙ্ক\n` +
    `<b>/auto2fa</b> — অটো Google 2FA সেটআপ\n` +
    `<b>/addresses</b> — অ্যাক্টিভ অ্যাড্রেস তালিকা\n` +
    `<b>/stats</b> — ওয়ার্কস্পেস স্ট্যাটাস\n` +
    `<b>/settings</b> — সেটিংস ও থিম\n\n` +
    `<i>টিপস: যেকোনো চ্যাটে <code>@botname</code> লিখে লাইভ 2FA বা OTP পাঠাতে পারবেন।</i>`,
    HTML
  ));
  bot.command('cancel', (ctx) => { pending.delete(ctx.from.id); return ctx.reply('✖️ বাতিল করা হয়েছে।'); });
  const cancelRow = btn.cb('✖️ Cancel', 'cx', 'danger');
  bot.callbackQuery('cx', async (ctx) => { pending.delete(ctx.from.id); await edit(ctx, '✖️ বাতিল করা হয়েছে।', undefined); });

  // ---------- generate ----------
  async function sendGen(ctx, asEdit = false, domain = '', local = '') {
    const uid = String(ctx.from.id);
    if (ctx.message?.message_id && ctx.chat?.id) {
      const prevCmd = lastGenCmdMsg.get(uid);
      if (prevCmd) await ctx.api.deleteMessage(ctx.chat.id, prevCmd).catch(() => {});
      await delUserMsg(ctx);
      lastGenCmdMsg.set(uid, ctx.message.message_id);
    }
    const chosenDom = domain || pickDomain(uid);
    const defaultTtl = store.getSettings(uid).ttl || 0;
    const rec = makeAddress(uid, chosenDom, local, defaultTtl);
    if (!rec) {
      return ctx.reply('⚠️ এই নামটি অন্য কেউ ব্যবহার করছে। অন্য নাম দিন।', { reply_markup: mainMenu(isAdmin(ctx.from.id)) });
    }
    const domLabel = rec.addr.split('@')[1] || '';
    const modeLabel = chosenDom === 'random' ? '🎲 Auto' : '';
    const cardText = genCard(rec, { domainLabel, modeLabel });
    const opts = genKeyboard(rec, { multiDomain: config.domains.length > 1 });

    if (asEdit) return edit(ctx, cardText, opts, rec.addr);

    const prev = store.getActiveCard(uid);
    if (prev?.chatId && prev?.messageId && !prev.gotMail) {
      await ctx.api.deleteMessage(prev.chatId, prev.messageId).catch(() => {});
    }
    const s = await ctx.reply(cardText, { ...HTML, reply_markup: opts }).catch(() => null);
    if (s) store.setActiveCard(uid, s.chat.id, s.message_id, rec.addr, false);
  }

  bot.command('gen', (ctx) => {
    const raw = String(ctx.match || '').trim();
    if (!raw) return sendGen(ctx);
    const m = raw.match(/^(?:([a-z0-9._-]+))?(?:\s*@([a-z0-9.-]+))?$/i);
    const local = cleanName(m?.[1] || '');
    const dom = m?.[2] && config.domains.includes(m[2].toLowerCase()) ? m[2].toLowerCase() : '';
    return sendGen(ctx, false, dom, local);
  });
  bot.hears(['⚡ Instant Mail', '⚡ Instant Mail (/gen)'], (ctx) => sendGen(ctx));
  bot.callbackQuery('gn', (ctx) => {
    const prev = store.getActiveCard(ctx.from.id);
    const onReceivedMail = prev?.gotMail && ctx.callbackQuery?.message?.message_id === prev.messageId;
    return sendGen(ctx, !onReceivedMail);
  });

  // ---------- domain picker ----------
  async function showDomainPicker(ctx, asEdit = false) {
    const u = store.getUser(ctx.from.id);
    const pref = typeof u?.prefDomain === 'number' ? u.prefDomain : -1;
    const text = head('🌐', 'Domain Selection') +
      'নতুন ইনস্ট্যান্ট মেইল যে ডোমেইনে তৈরি হবে:\n' +
      `বর্তমান মোড: <b>${pref === -1 ? '🎲 Auto-Random' : esc(config.domains[pref] || config.domains[0])}</b>`;
    const markup = rows(
      [btn.cb(`${pref === -1 ? '✅ ' : '🎲 '}Auto-Random (সব ডোমেইন)`, 'gs:-1', pref === -1 ? 'success' : 'primary')],
      ...config.domains.map((d, i) => [btn.cb(`${pref === i ? '✅ ' : '🌐 '}${d}`, `gs:${i}`, pref === i ? 'success' : 'primary')]),
      [btn.cb('⬅️ Generate Mail', 'gn', 'primary')]
    );
    return asEdit ? edit(ctx, text, markup) : ctx.reply(text, { ...HTML, reply_markup: markup });
  }
  bot.command('domain', (ctx) => showDomainPicker(ctx));
  bot.hears('🌐 Domain', async (ctx) => { await delUserMsg(ctx); return showDomainPicker(ctx); });
  bot.callbackQuery('gd', (ctx) => showDomainPicker(ctx, true));
  bot.callbackQuery(/^gs:(-?\d+)$/, async (ctx) => {
    const i = Number(ctx.match[1]);
    if (i < -1 || i >= config.domains.length) return;
    store.setPrefDomain(ctx.from.id, i);
    await ctx.answerCallbackQuery({ text: i === -1 ? '🎲 Auto-Random সক্রিয়' : `🌐 ${config.domains[i]} সক্রিয়` });
    await sendGen(ctx, true, i === -1 ? 'random' : config.domains[i]);
  });

  // ---------- custom / change name ----------
  async function askName(ctx, domain = '', prompt = '🎯 <b>কাস্টম নাম লিখুন</b>') {
    await delUserMsg(ctx);
    const oldP = pending.get(ctx.from.id);
    if (oldP?.promptMsgId && ctx.chat?.id) await ctx.api.deleteMessage(ctx.chat.id, oldP.promptMsgId).catch(() => {});
    const chosenDom = domain && domain !== 'random' ? domain : (config.domains[0] || 'safix.tech');
    const pm = await ctx.reply(
      `${prompt}\n<i>a-z, 0-9, . _ - (কমপক্ষে ৩ অক্ষর) — অথবা <code>name@${esc(chosenDom)}</code></i>`,
      { ...HTML, reply_markup: rows([cancelRow]) }
    ).catch(() => null);
    pending.set(ctx.from.id, { type: 'newname', domain: domain || pickDomain(ctx.from.id), promptMsgId: pm?.message_id });
  }
  bot.command('custom', async (ctx) => {
    const raw = String(ctx.match || '').trim();
    const parts = raw.split('@');
    const arg = cleanName(parts[0] || '');
    const dom = parts[1] && config.domains.includes(parts[1].toLowerCase()) ? parts[1].toLowerCase() : pickDomain(ctx.from.id);
    if (arg.length >= 3) return sendGen(ctx, false, dom, arg);
    return askName(ctx, dom);
  });
  bot.hears('🎯 Custom', (ctx) => askName(ctx, pickDomain(ctx.from.id)));
  bot.callbackQuery(/^cn:(\w+)$/, (ctx) => sendGen(ctx, true));

  // ---------- labels & address rename ----------
  bot.callbackQuery(/^rl:(\w*):(\w*)$/, async (ctx) => {
    let rec = ctx.match[1] && ctx.match[1] !== 'x' ? store.getAddressById(ctx.match[1]) : null;
    if (!rec && ctx.match[2]) {
      const m = store.getMessage(ctx.match[2]);
      if (m && m.owner === String(ctx.from.id)) rec = store.ensureAddress(m.owner, m.to);
    }
    if (!rec || rec.owner !== String(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'এই অ্যাড্রেসটি আপনার নয়', show_alert: true });
    await delPrompt(ctx, pending.get(ctx.from.id));
    const pm = await ctx.reply(`🏷 <code>${esc(rec.addr)}</code>\nএর জন্য একটি লেবেল লিখুন (যেমন: Netflix, Dev):`, { ...HTML, reply_markup: rows([cancelRow]) }).catch(() => null);
    pending.set(ctx.from.id, { type: 'label', id: rec.id, promptMsgId: pm?.message_id });
  });
  bot.callbackQuery(/^ar:(\w+)$/, async (ctx) => {
    const rec = store.getAddressById(ctx.match[1]);
    if (!rec || rec.owner !== String(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'এই অ্যাড্রেসটি আপনার নয়', show_alert: true });
    await delPrompt(ctx, pending.get(ctx.from.id));
    const domsText = config.domains.map((d) => `@${esc(d)}`).join(' · ');
    const pm = await ctx.reply(
      `✏️ <b>অ্যাড্রেস রিনেম / এডিট</b>\nবর্তমান: <code>${esc(rec.addr)}</code>\n\nনতুন নাম পাঠান (যেমন: <code>myname</code> অথবা <code>myname@${esc(config.domains[0])}</code>)\n<i>ডোমেইন: ${domsText}</i>`,
      { ...HTML, reply_markup: rows([cancelRow]) }
    ).catch(() => null);
    pending.set(ctx.from.id, { type: 'addr_rename', id: rec.id, promptMsgId: pm?.message_id });
  });

  // ---------- messages ----------
  async function showCard(ctx, msg, back = false) {
    const rec = store.getAddress(msg.to);
    store.markRead(msg.id);
    const style = store.getSettings(ctx.from.id).style;
    await edit(ctx, mailCard(msg, rec, style), mailKeyboard({ ...msg, addrId: rec?.id }, { style, back }));
  }
  bot.callbackQuery(/^mm:(\w+)$/, async (ctx) => {
    const m = getOwned(ctx, ctx.match[1]);
    if (!m) return edit(ctx, '❌ মেসেজটি আর নেই।', undefined);
    await showCard(ctx, m);
  });
  bot.callbackQuery(/^mo:(\w+)$/, async (ctx) => {
    const m = getOwned(ctx, ctx.match[1]);
    if (!m) return edit(ctx, '❌ মেসেজটি আর নেই।', undefined);
    await showCard(ctx, m, true);
  });
  bot.callbackQuery(/^fm:(\w+)$/, async (ctx) => {
    const m = getOwned(ctx, ctx.match[1]);
    if (!m) return edit(ctx, '❌ মেসেজটি আর নেই।', undefined);
    store.markRead(m.id);
    await edit(ctx, fullMessageText(m), rows(
      [m.html ? btn.cb('📎 HTML ফাইল', `fh:${m.id}`, 'primary') : null, btn.cb(m.pinned ? '📌 Pinned' : '📌 Pin', `pm:${m.id}`, m.pinned ? 'success' : 'primary')],
      [m.otp ? btn.copy(`🔒 ${m.otp}`, m.otp, 'success') : null],
      [btn.cb('⬅️ Back', `mm:${m.id}`, 'primary'), btn.cb('🗑 Delete', `dm:${m.id}`, 'danger')]
    ));
  });
  bot.callbackQuery(/^pm:(\w+)$/, async (ctx) => {
    const m = getOwned(ctx, ctx.match[1]);
    if (!m) return;
    store.pinMessage(m.owner, m.id, !m.pinned);
    await ctx.answerCallbackQuery({ text: m.pinned ? '📌 পিন করা হয়েছে' : '📌 আনপিন করা হয়েছে' });
    await edit(ctx, fullMessageText(m), rows(
      [m.html ? btn.cb('📎 HTML ফাইল', `fh:${m.id}`, 'primary') : null, btn.cb(m.pinned ? '📌 Pinned' : '📌 Pin', `pm:${m.id}`, m.pinned ? 'success' : 'primary')],
      [m.otp ? btn.copy(`🔒 ${m.otp}`, m.otp, 'success') : null],
      [btn.cb('⬅️ Back', `mm:${m.id}`, 'primary'), btn.cb('🗑 Delete', `dm:${m.id}`, 'danger')]
    ));
  });
  bot.callbackQuery(/^fh:(\w+)$/, async (ctx) => {
    const m = getOwned(ctx, ctx.match[1]);
    if (!m?.html) return;
    await ctx.replyWithDocument(new InputFile(Buffer.from(m.html, 'utf8'), `mail-${m.id}.html`), { caption: `📎 ${m.service.name} • ${m.purpose}` });
  });
  bot.callbackQuery(/^dm:(\w+)$/, async (ctx) => {
    await edit(ctx, '🗑 <b>এই মেসেজটি ডিলিট করবেন?</b>', rows([btn.cb('✅ হ্যাঁ, ডিলিট', `dy:${ctx.match[1]}`, 'danger'), btn.cb('↩️ না', `mm:${ctx.match[1]}`, 'success')]));
  });
  bot.callbackQuery(/^dy:(\w+)$/, async (ctx) => {
    if (getOwned(ctx, ctx.match[1])) store.deleteMessage(ctx.match[1]);
    await edit(ctx, '🗑 মেসেজ ডিলিট হয়েছে।', rows([btn.cb('📬 Inbox', 'ib:0', 'primary')]));
  });

  // ---------- inbox ----------
  async function inbox(ctx, offset = 0, asEdit = false, query = '') {
    const all = store.listMessages(ctx.from.id, { limit: 200, q: query });
    const page = all.slice(offset, offset + 8);
    const unread = store.countUnread(ctx.from.id);
    const headTitle = query ? `Inbox: "${query}"` : 'Inbox';
    const text = head('📬', headTitle) + (all.length ? `মোট <b>${all.length}</b> · অপঠিত <b>${unread}</b>` : '📭 এখনো কোনো মেসেজ আসেনি।\n<i>/gen দিয়ে মেইল নিয়ে ব্যবহার করুন।</i>');
    const list = page.map((m) => [
      btn.cb(`${m.read ? '' : '🔵 '}${m.service.icon} ${m.service.name} · ${(m.otp || m.purpose).slice(0, 22)}  ${fmtTime(m.date)}`.slice(0, 60), `mo:${m.id}`, m.read ? 'primary' : 'success'),
    ]);
    const nav = [];
    if (offset > 0) nav.push(btn.cb('⬅️ Prev', `ib:${Math.max(0, offset - 8)}`, 'primary'));
    if (offset + 8 < all.length) nav.push(btn.cb('Next ➡️', `ib:${offset + 8}`, 'primary'));
    const appBtn = btn.app('📱 Mini App', '', 'success');
    const markup = rows(...list, nav, [btn.cb('🔄 Refresh', `ib:${offset}`, 'success'), btn.cb('✅ সব পঠিত', `ra:${offset}`, 'primary'), btn.cb('🏠', 'qp', 'primary')], ...(appBtn ? [[appBtn]] : []));
    return asEdit ? edit(ctx, text, markup) : ctx.reply(text, { ...HTML, reply_markup: markup });
  }
  bot.command('inbox', (ctx) => inbox(ctx, 0, false, String(ctx.match || '').trim()));
  bot.hears('📬 Inbox', async (ctx) => { await delUserMsg(ctx); return inbox(ctx); });
  bot.hears(['📮 My Addresses', '📧 Gmail'], async (ctx) => {
    await delUserMsg(ctx);
    return ctx.text?.includes('Gmail') ? gmailHome(ctx) : addresses(ctx);
  });
  bot.callbackQuery(/^ib:(\d+)$/, (ctx) => inbox(ctx, Number(ctx.match[1]), true));
  bot.callbackQuery(/^ra:(\d+)$/, async (ctx) => { store.markAllRead(ctx.from.id); await inbox(ctx, Number(ctx.match[1]), true); });

  // ---------- addresses ----------
  async function addresses(ctx, asEdit = false) {
    const list = store.listAddresses(ctx.from.id).filter((a) => !a.expired).slice(0, 12);
    const text = head('📮', 'Active Addresses') + (list.length ? 'একটিতে ট্যাপ করে ম্যানেজ করুন:' : 'এখনো কোনো অ্যাড্রেস নেই। /gen চাপুন।');
    const markup = rows(
      ...list.map((a) => [btn.cb(`${a.pinned ? '★ ' : '📧 '}${a.label ? `${a.label} · ` : ''}${a.addr}`.slice(0, 60), `av:${a.id}`, 'primary')]),
      [btn.cb('⚡ New Mail', 'gn', 'success'), btn.cb('🌐 Domain', 'gd', 'primary'), btn.cb('🏠 Panel', 'qp', 'primary')]
    );
    return asEdit ? edit(ctx, text, markup) : ctx.reply(text, { ...HTML, reply_markup: markup });
  }
  bot.command('addresses', (ctx) => addresses(ctx));
  bot.callbackQuery('as', (ctx) => addresses(ctx, true));
  bot.callbackQuery(/^av:(\w+)$/, async (ctx) => {
    const a = store.getAddressById(ctx.match[1]);
    if (!a || a.owner !== String(ctx.from.id)) return edit(ctx, '❌ পাওয়া যায়নি।', undefined);
    await edit(ctx, head('📧', 'Address') + `<code>${esc(a.addr)}</code>${a.label ? `\n🏷 <i>${esc(a.label)}</i>` : ''}`, rows(
      [btn.copy('📋 Copy', a.addr, 'success'), btn.cb(a.pinned ? '★ Pinned' : '☆ Pin', `ap:${a.id}`, a.pinned ? 'success' : 'primary'), btn.cb('✏️ Rename', `ar:${a.id}`, 'primary')],
      [btn.cb('🏷 Label', `rl:${a.id}:`, 'primary'), btn.cb('⏳ TTL', `gt:${a.id}`, 'primary'), btn.cb('🗑 Delete', `ad:${a.id}`, 'danger')],
      [btn.cb('⬅️ Back', 'as', 'primary')]
    ));
  });
  bot.callbackQuery(/^ap:(\w+)$/, async (ctx) => {
    const a = store.getAddressById(ctx.match[1]);
    if (!a || a.owner !== String(ctx.from.id)) return;
    store.setPinnedAddress(ctx.from.id, a.id, !a.pinned);
    await ctx.answerCallbackQuery({ text: a.pinned ? '★ পিন করা হয়েছে' : '☆ আনপিন হয়েছে' });
    await addresses(ctx, true);
  });
  bot.callbackQuery(/^ad:(\w+)$/, (ctx) => edit(ctx, '🗑 <b>অ্যাড্রেসটি ডিলিট করবেন?</b>', rows([btn.cb('✅ ডিলিট', `ay:${ctx.match[1]}`, 'danger'), btn.cb('↩️ না', `av:${ctx.match[1]}`, 'success')])));
  bot.callbackQuery(/^ay:(\w+)$/, async (ctx) => {
    const a = store.getAddressById(ctx.match[1]);
    if (a && a.owner === String(ctx.from.id)) store.deleteAddress(a.id);
    await addresses(ctx, true);
  });

  // ---------- gmail ----------
  async function gmailHome(ctx, asEdit = false) {
    const list = store.listGmail(ctx.from.id);
    const stateIcon = (g) => (g.status === 'expired' ? '🔴' : '🟢');
    const text = head('📧', 'Gmail Connect & Live OTP') + (list.length ? list.map((g) => `${stateIcon(g)} <code>${esc(g.email)}</code>`).join('\n') : 'কোনো Gmail যুক্ত নেই।') + '\n\n👇 <b>যেকোনো একটি পদ্ধতিতে কানেক্ট করুন:</b>';
    const appBtn = btn.app('🚀 Open Hub (Mini App)', '?tab=hub', 'success');
    const markup = rows(
      [gmailEnabled() ? btn.url('🟢 Continue with Gmail', gmailAuthUrl(ctx.from.id), 'success') : btn.cb('🟢 Continue with Gmail', 'ga', 'success')],
      [btn.cb('📱 Email + Password (2FA)', 'gm:phone', 'primary'), btn.cb('🔑 App Password', 'gm:app', 'primary')],
      ...list.map((g, i) => [btn.cb(`🗑 ${g.email}`, `gx:${i}`, 'danger')]),
      [...(appBtn ? [appBtn] : []), btn.cb('🏠 Panel', 'qp', 'primary')]
    );
    return asEdit ? edit(ctx, text, markup) : ctx.reply(text, { ...HTML, reply_markup: markup });
  }
  bot.command('gmail', (ctx) => gmailHome(ctx));
  bot.callbackQuery('gm', (ctx) => gmailHome(ctx, true));
  bot.callbackQuery('ga', async (ctx) => {
    if (gmailEnabled()) return edit(ctx, head('🟢', 'Continue with Gmail') + 'নিচের বাটনে ট্যাপ করে Google অ্যাকাউন্ট সিলেক্ট করুন:', rows([btn.url('🟢 Continue with Gmail', gmailAuthUrl(ctx.from.id), 'success')], [btn.cb('⬅️ Back', 'gm', 'primary')]));
    return edit(ctx, head('📱', 'Gmail লগইন') + 'নিচের বাটন থেকে App Password বা Password দিয়ে যুক্ত করুন:', rows([btn.cb('📱 Email + Password (2FA)', 'gm:phone', 'primary')], [btn.cb('🔑 Email + App Password', 'gm:app', 'success')], [btn.cb('⬅️ Back', 'gm', 'primary')]));
  });
  bot.callbackQuery('gm:phone', async (ctx) => { pending.set(ctx.from.id, { type: 'gm_email', mode: 'phone' }); await edit(ctx, head('📱', 'ধাপ ১/৩: আপনার Gmail ঠিকানা') + 'আপনার <b>Gmail অ্যাড্রেসটি</b> লিখে পাঠান (যেমন: <code>example@gmail.com</code>):', rows([cancelRow])); });
  bot.callbackQuery('gm:app', async (ctx) => { pending.set(ctx.from.id, { type: 'gm_email', mode: 'app_pass' }); await edit(ctx, head('🔑', 'ধাপ ১/২: আপনার Gmail ঠিকানা') + 'আপনার <b>Gmail অ্যাড্রেসটি</b> লিখে পাঠান (যেমন: <code>example@gmail.com</code>):', rows([cancelRow])); });
  bot.callbackQuery(/^gx:(\d+)$/, async (ctx) => {
    const g = store.listGmail(ctx.from.id)[Number(ctx.match[1])];
    if (!g) return gmailHome(ctx, true);
    await edit(ctx, `🗑 <b>${esc(g.email)}</b> সরিয়ে দেবেন?`, rows([btn.cb('✅ সরান', `gy:${ctx.match[1]}`, 'danger'), btn.cb('↩️ না', 'gm', 'success')]));
  });
  bot.callbackQuery(/^gy:(\d+)$/, async (ctx) => {
    const g = store.listGmail(ctx.from.id)[Number(ctx.match[1])];
    if (g) store.removeGmail(ctx.from.id, g.email);
    await gmailHome(ctx, true);
  });

  // ---------- 2FA Authenticator Vault in Bot ----------
  async function showTotpBot(ctx, asEdit = false, search = '') {
    const all = store.listTotp(ctx.from.id);
    const items = search ? all.filter((x) => `${x.name} ${x.issuer || ''} ${x.category || ''}`.toLowerCase().includes(search.toLowerCase())) : all;
    const { text, markup } = totpVaultView(items, { isAdmin: isAdmin(ctx.from.id) });
    return asEdit ? edit(ctx, text, markup) : ctx.reply(text, { ...HTML, reply_markup: markup });
  }
  bot.command('2fa', (ctx) => showTotpBot(ctx, false, String(ctx.match || '').trim()));
  bot.hears('🔐 2FA Vault', async (ctx) => { await delUserMsg(ctx); return showTotpBot(ctx); });
  bot.command('add2fa', async (ctx) => {
    const raw = String(ctx.match || '').trim();
    if (!raw) {
      pending.set(ctx.from.id, { type: 'totp_add' });
      return ctx.reply(
        head('➕', 'Add / Batch Import 2FA') +
        'যেকোনো ফরম্যাটে পাঠান:\n• <code>Google | JBSWY3DPEHPK3PXP</code>\n• <code>otpauth://totp/...</code> URI\n• Google Authenticator <code>otpauth-migration://offline?data=...</code>\n• অথবা শুধু Secret Key',
        { ...HTML, reply_markup: rows([cancelRow]) }
      );
    }
    await delUserMsg(ctx);
    const added = store.importTotpBulk(ctx.from.id, raw);
    if (!added.length) return ctx.reply('⚠️ সঠিক 2FA Secret Key বা otpauth URI দিন।', HTML);
    return showTotpBot(ctx, false);
  });
  bot.callbackQuery('tf:home', (ctx) => showTotpBot(ctx, true));
  bot.callbackQuery('totp:list', (ctx) => showTotpBot(ctx, true));
  bot.callbackQuery('tf:add', async (ctx) => {
    pending.set(ctx.from.id, { type: 'totp_add' });
    await edit(
      ctx,
      head('➕', 'নতুন 2FA / ব্যাকআপ যুক্ত করুন') +
        'নিচের যেকোনো ফরম্যাটে পাঠান:\n\n' +
        '• <code>GitHub | JBSWY3DPEHPK3PXP</code>\n' +
        '• <code>otpauth://totp/...</code>\n' +
        '• <code>otpauth-migration://offline?data=...</code>\n' +
        '• একাধিক লাইন একসাথে Bulk পেস্ট',
      rows([cancelRow])
    );
  });
  bot.callbackQuery(/^tf:pin:(\w+)$/, async (ctx) => {
    const cur = store.listTotp(ctx.from.id).find((x) => x.id === ctx.match[1]);
    if (cur) store.pinTotp(ctx.from.id, cur.id, !cur.pinned);
    await ctx.answerCallbackQuery({ text: cur?.pinned ? '☆ আনপিন হয়েছে' : '★ টপে পিন হয়েছে' });
    await showTotpBot(ctx, true);
  });
  bot.callbackQuery(/^tf:ed:(\w+)$/, async (ctx) => {
    const cur = store.listTotp(ctx.from.id).find((x) => x.id === ctx.match[1]);
    if (!cur) return ctx.answerCallbackQuery({ text: 'এন্ট্রি পাওয়া যায়নি', show_alert: true });
    await delPrompt(ctx, pending.get(ctx.from.id));
    const pm = await ctx.reply(
      `✏️ <b>2FA রিনেম / এডিট</b>\nবর্তমান: <b>${esc(cur.name)}</b>${cur.issuer ? ` (${esc(cur.issuer)})` : ''}\n\nনতুন নাম লিখুন অথবা <code>Name | Issuer</code> পাঠান:`,
      { ...HTML, reply_markup: rows([cancelRow]) }
    ).catch(() => null);
    pending.set(ctx.from.id, { type: 'totp_edit', id: cur.id, promptMsgId: pm?.message_id });
  });
  bot.callbackQuery(/^tf:del:(\w+)$/, async (ctx) => {
    store.removeTotp(ctx.from.id, ctx.match[1]);
    await ctx.answerCallbackQuery({ text: '🗑 2FA মুছে ফেলা হয়েছে' });
    await showTotpBot(ctx, true);
  });

  // ---------- Auto 2FA ----------
  bot.command('auto2fa', async (ctx) => {
    const raw = String(ctx.match || '').trim();
    if (raw && raw.includes('@')) {
      await delUserMsg(ctx);
      const parts = raw.includes('|') ? raw.split('|') : raw.split(/\s+/);
      const email = (parts[0] || '').trim(), password = (parts[1] || '').trim(), recoveryEmail = (parts[2] || '').trim();
      if (!password) {
        pending.set(ctx.from.id, { type: 'a2fa_start', email });
        return ctx.reply(`🤖 <b>${esc(email)}</b>-এর পাসওয়ার্ড পাঠান:`, { ...HTML, reply_markup: rows([cancelRow]) });
      }
      const r = await startAuto2faJob({ uid: ctx.from.id, email, password, recoveryEmail });
      if (!r.ok) return ctx.reply(`⚠️ ${esc(r.error)}`, HTML);
      return;
    }
    pending.set(ctx.from.id, { type: 'a2fa_start' });
    return ctx.reply(head('🤖', 'Auto 2FA Engine') + 'আপনার Gmail এবং Password নিচের ফরম্যাটে পাঠান:\n<code>example@gmail.com | your_password</code>', { ...HTML, reply_markup: rows([cancelRow]) });
  });
  bot.callbackQuery('a2fa:new', async (ctx) => {
    pending.set(ctx.from.id, { type: 'a2fa_start' });
    await edit(ctx, head('🤖', 'Auto 2FA Engine') + 'আপনার Gmail এবং Password নিচের ফরম্যাটে পাঠান:\n<code>example@gmail.com | your_password</code>', rows([cancelRow]));
  });
  bot.callbackQuery(/^a2fa:(cont|alt|snap|stop):([^:]+)$/, async (ctx) => {
    const [, act, jobId] = ctx.match;
    if (act === 'stop') {
      await performAuto2faAction(jobId, { action: 'stop' });
      pending.delete(ctx.from.id);
      await ctx.answerCallbackQuery({ text: '🛑 অটো 2FA বাতিল করা হয়েছে' });
      return ctx.reply('🛑 অটো 2FA সেশন বাতিল করা হয়েছে।', HTML);
    }
    if (act === 'cont') {
      await ctx.answerCallbackQuery({ text: '✅ পরবর্তী ধাপে এগিয়ে যাওয়া হচ্ছে…' });
      await performAuto2faAction(jobId, { action: 'continue' });
      return;
    }
    if (act === 'alt') {
      await ctx.answerCallbackQuery({ text: '🔄 বিকল্প ভেরিফিকেশন অপশন আনা হচ্ছে…' });
      const r = await performAuto2faAction(jobId, { action: 'alt' });
      if (r.ok && r.job?.screenshot) {
        const optRows = (r.job.options || []).slice(0, 4).map((o) => [btn.cb(`👉 ${o.text.slice(0, 38)}`, `a2fa:opt:${jobId}:${o.idx}`, 'primary')]);
        await sendBotPhoto(ctx.from.id, r.job.screenshot, `🔄 <b>বিকল্প অপশন (${esc(r.job.email)}):</b>`, rows(...optRows, [btn.cb('✅ কন্টিনিউ', `a2fa:cont:${jobId}`, 'success')], [btn.cb('🛑 বাতিল', `a2fa:stop:${jobId}`, 'danger')]));
      }
      return;
    }
    if (act === 'snap') {
      await ctx.answerCallbackQuery({ text: '📸 স্ক্রিনশট নেওয়া হচ্ছে…' });
      const r = await performAuto2faAction(jobId, { action: 'snap' });
      if (r.ok && r.job?.screenshot) {
        await sendBotPhoto(ctx.from.id, r.job.screenshot, `📸 <b>লাইভ ব্রাউজার (${esc(r.job.email)})</b>`, rows([btn.cb('✅ কন্টিনিউ', `a2fa:cont:${jobId}`, 'success'), btn.cb('🔄 রিফ্রেশ', `a2fa:snap:${jobId}`, 'primary')], [btn.cb('🛑 বাতিল', `a2fa:stop:${jobId}`, 'danger')]));
      }
    }
  });
  bot.callbackQuery(/^a2fa:opt:([^:]+):(\d+)$/, async (ctx) => {
    const [, jobId, idx] = ctx.match;
    await ctx.answerCallbackQuery({ text: '👉 অপশন সিলেক্ট করা হচ্ছে…' });
    const r = await performAuto2faAction(jobId, { action: 'option', optionIdx: Number(idx) });
    if (r.ok && r.job?.screenshot) {
      pending.set(ctx.from.id, { type: 'a2fa_input', jobId });
      await sendBotPhoto(ctx.from.id, r.job.screenshot, `✍️ <b>${esc(r.job.email)}</b>: কোড বা রিকভারি তথ্য পাঠান:`, rows([btn.cb('✅ কন্টিনিউ', `a2fa:cont:${jobId}`, 'success')], [btn.cb('🛑 বাতিল', `a2fa:stop:${jobId}`, 'danger')]));
    }
  });

  // ---------- admin ----------
  const adminOnly = (ctx) => isAdmin(ctx.from.id) || (ctx.answerCallbackQuery?.({ text: 'Admin only', show_alert: true }).catch(() => {}), false);
  function adminText() {
    const s = store.stats();
    const t = titanStatus();
    const up = Math.floor((Date.now() - startedAt) / 60000);
    return (
      head('👑', 'Admin Panel') +
      `👥 Users <b>${s.users}</b>  ⏳ Pending <b>${s.pending}</b>  ⛔ Banned <b>${s.banned}</b>\n` +
      `📮 Addresses <b>${s.addresses}</b>  📬 Mails <b>${s.messages}</b>  📅 Today <b>${s.today}</b>\n` +
      `📧 Gmail <b>${s.gmail}</b>  🖥 Titan <b>${t.online}/${t.total}</b>  🛡 2FA <b>${s.totp}</b>\n` +
      `${config.openAccess ? '🔓 Access: <b>Open</b>' : '🔒 Access: <b>Approval</b>'}  ⏱ <b>${Math.floor(up / 60)}h ${up % 60}m</b>`
    );
  }
  const adminMarkup = () => {
    const appBtn = btn.app('🛰 Open Control Panel', '?tab=admin', 'success');
    return rows(
      [btn.cb('🛡 2FA Vault', 'tf:home', 'success'), btn.cb('🧹 Sweep Expired', 'am:sweep', 'primary')],
      [btn.cb('👥 Users', 'am:users:0', 'primary'), btn.cb(`⏳ Pending (${store.stats().pending})`, 'am:pend', 'primary')],
      [btn.cb('📢 Broadcast', 'am:bc', 'success'), btn.cb(config.openAccess ? '🔒 Approval Mode' : '🔓 Open Access', 'am:access', config.openAccess ? 'danger' : 'primary')],
      [...(appBtn ? [appBtn] : []), btn.cb('🔄 Refresh', 'am:home', 'primary')]
    );
  };
  bot.callbackQuery('am:access', async (ctx) => {
    if (!adminOnly(ctx)) return;
    config.openAccess = !config.openAccess;
    store.setMeta('openAccess', config.openAccess);
    await edit(ctx, adminText(), adminMarkup());
  });
  bot.callbackQuery('am:sweep', async (ctx) => {
    if (!adminOnly(ctx)) return;
    const hit = store.expireSweep();
    await ctx.answerCallbackQuery({ text: `🧹 ${hit.length}টি মেয়াদোত্তীর্ণ ঠিকানা ক্লিন হয়েছে` });
    await edit(ctx, adminText(), adminMarkup());
  });
  bot.command('admin', (ctx) => isAdmin(ctx.from.id) && ctx.reply(adminText(), { ...HTML, reply_markup: adminMarkup() }));
  bot.hears(['👑 Admin', '👑 Admin Panel'], async (ctx) => { if (!isAdmin(ctx.from.id)) return; await delUserMsg(ctx); await edit(ctx, adminText(), adminMarkup()); });
  bot.callbackQuery('am:home', async (ctx) => adminOnly(ctx) && edit(ctx, adminText(), adminMarkup()));

  const stIcon = { approved: '✅', pending: '⏳', banned: '⛔' };
  bot.callbackQuery(/^am:users:(\d+)$/, async (ctx) => {
    if (!adminOnly(ctx)) return;
    const off = Number(ctx.match[1]);
    const all = store.listUsers().sort((a, b) => b.lastSeen - a.lastSeen);
    const nav = [];
    if (off > 0) nav.push(btn.cb('⬅️ Prev', `am:users:${off - 8}`, 'primary'));
    if (off + 8 < all.length) nav.push(btn.cb('Next ➡️', `am:users:${off + 8}`, 'primary'));
    await edit(ctx, head('👥', 'Users') + `মোট ${all.length}`, rows(...all.slice(off, off + 8).map((u) => [btn.cb(`${stIcon[u.status]} ${u.name}`.slice(0, 50), `am:u:${u.id}`, u.status === 'banned' ? 'danger' : u.status === 'pending' ? 'success' : 'primary')]), nav, [btn.cb('⬅️ Back', 'am:home', 'primary')]));
  });
  bot.callbackQuery(/^am:u:(\d+)$/, async (ctx) => {
    if (!adminOnly(ctx)) return;
    const u = store.getUser(ctx.match[1]);
    if (!u) return;
    await edit(ctx, head('👤', u.name) + `🆔 <code>${u.id}</code>${u.username ? `\n@${esc(u.username)}` : ''}\nStatus: ${stIcon[u.status]} <b>${u.status}</b>\n📮 ${store.listAddresses(u.id).length} addresses`, rows(
      [u.status === 'banned' ? btn.cb('♻️ Unban', `am:ok:${u.id}`, 'success') : btn.cb('⛔ Ban', `am:ban:${u.id}`, 'danger')],
      [btn.cb('⬅️ Back', 'am:users:0', 'primary')]
    ));
  });
  bot.callbackQuery('am:pend', async (ctx) => {
    if (!adminOnly(ctx)) return;
    const p = store.listUsers().filter((u) => u.status === 'pending');
    await edit(ctx, head('⏳', 'Pending Requests') + (p.length ? '' : 'কোনো পেন্ডিং রিকোয়েস্ট নেই।'), rows(...p.map((u) => [btn.cb(`✅ ${u.name}`.slice(0, 30), `am:ok:${u.id}`, 'success'), btn.cb('⛔', `am:no:${u.id}`, 'danger')]), [btn.cb('⬅️ Back', 'am:home', 'primary')]));
  });
  bot.callbackQuery(/^am:(ok|no|ban):(\d+)$/, async (ctx) => {
    if (!adminOnly(ctx)) return;
    const [, act, id] = ctx.match;
    const u = store.setUserStatus(id, act === 'ok' ? 'approved' : 'banned');
    if (!u) return;
    if (act === 'ok') await safeSend(id, '✅ <b>Your access request was accepted.</b>\n\n⚡ শুরু করতে /start চাপুন।', undefined);
    await edit(ctx, `${act === 'ok' ? '✅ Approved' : '⛔ Rejected/Banned'}: <b>${esc(u.name)}</b>`, rows([btn.cb('👑 Admin Panel', 'am:home', 'primary')]));
  });
  bot.callbackQuery('am:bc', async (ctx) => {
    if (!adminOnly(ctx)) return;
    pending.set(ctx.from.id, { type: 'broadcast' });
    await ctx.reply('📢 <b>ব্রডকাস্ট মেসেজ লিখুন</b> (সব approved ইউজারের কাছে যাবে):', { ...HTML, reply_markup: rows([cancelRow]) });
  });
  bot.callbackQuery('am:bcy', async (ctx) => {
    if (!adminOnly(ctx)) return;
    const p = pending.get(ctx.from.id);
    if (p?.type !== 'broadcast-confirm') return;
    pending.delete(ctx.from.id);
    const targets = store.listUsers().filter((u) => u.status === 'approved');
    await edit(ctx, `📤 পাঠানো হচ্ছে… (${targets.length} জন)`, undefined);
    let ok = 0;
    for (const u of targets) {
      if (await safeSend(u.id, `📢 <b>Announcement</b>\n${HR}\n${esc(p.text)}`, undefined)) ok++;
      await new Promise((r) => setTimeout(r, 40));
    }
    await ctx.reply(`✅ ${ok}/${targets.length} জনের কাছে পাঠানো হয়েছে।`);
  });

  // ---------- free-text (pending actions + smart URI detection) ----------
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    let p = pending.get(ctx.from.id);
    if (!p) {
      const activeJob = getActiveJobForUser(ctx.from.id);
      if (activeJob && (activeJob.status === 'waiting_code' || activeJob.status === 'waiting_captcha' || activeJob.status === 'waiting_approval')) {
        p = { type: 'a2fa_input', jobId: activeJob.id };
      } else if (/^otpauth(-migration)?:\/\//i.test(text)) {
        await delUserMsg(ctx);
        const added = store.importTotpBulk(ctx.from.id, text);
        if (added.length) {
          await ctx.reply(`✅ <b>${added.length}টি 2FA এন্ট্রি ভল্টে যুক্ত হয়েছে!</b>`, HTML);
          return showTotpBot(ctx, false);
        }
      }
    }
    if (!p) return;

    if (p.type === 'a2fa_start') {
      await delUserMsg(ctx);
      let email = p.email || '', password = '', recoveryEmail = '';
      if (email && !text.includes('@')) password = text;
      else if (text.includes('|')) { const parts = text.split('|').map((s) => s.trim()); email = parts[0] || email; password = parts[1] || ''; recoveryEmail = parts[2] || ''; }
      else { const parts = text.split(/\s+/); email = parts[0] || email; password = parts.slice(1).join(' '); }
      if (!email || !email.includes('@')) return ctx.reply('⚠️ সঠিক ফরম্যাটে পাঠান: <code>example@gmail.com | your_password</code>', { ...HTML, reply_markup: rows([cancelRow]) });
      if (!password || password.length < 4) { pending.set(ctx.from.id, { type: 'a2fa_start', email }); return ctx.reply(`🔑 এখন <code>${esc(email)}</code>-এর পাসওয়ার্ডটি পাঠান:`, { ...HTML, reply_markup: rows([cancelRow]) }); }
      pending.delete(ctx.from.id);
      const r = await startAuto2faJob({ uid: ctx.from.id, email, password, recoveryEmail });
      if (!r.ok) return ctx.reply(`⚠️ ${esc(r.error)}`, HTML);
      return;
    }

    if (p.type === 'a2fa_input') {
      await delUserMsg(ctx);
      await ctx.reply('⚡ অটো 2FA বটে পাঠানো হয়েছে — ভেরিফাই করা হচ্ছে…', HTML);
      await performAuto2faAction(p.jobId, { action: 'input', text });
      return;
    }

    if (p.type === 'gm_email') {
      const email = text.toLowerCase().trim();
      if (!email.includes('@')) return ctx.reply('⚠️ সঠিক Gmail ঠিকানা লিখুন (যেমন: example@gmail.com)');
      await delUserMsg(ctx);
      pending.set(ctx.from.id, { type: 'gm_pass', email, mode: p.mode });
      const msgTxt = p.mode === 'app_pass'
        ? head('🔑', 'ধাপ ২/২: App Password দিন') + `👤 <code>${esc(email)}</code>\nআপনার ১৬-অক্ষরের <b>Google App Password</b> লিখে পাঠান:`
        : head('🔐', 'ধাপ ২/৩: পাসওয়ার্ড দিন') + `👤 <code>${esc(email)}</code>\nআপনার <b>Gmail পাসওয়ার্ড</b> লিখে পাঠান:`;
      return ctx.reply(msgTxt, { ...HTML, reply_markup: rows([btn.url('🔗 2FA App Password নিন ↗', 'https://myaccount.google.com/apppasswords', 'primary')], [cancelRow]) });
    }

    if (p.type === 'gm_pass') {
      const rawPass = text.trim();
      await delUserMsg(ctx);
      pending.delete(ctx.from.id);
      const waitMsg = await ctx.reply('⏳ <b>Gmail কানেক্ট করা হচ্ছে...</b>', HTML);
      try {
        const { ImapFlow } = await import('imapflow');
        const cleanPass = rawPass.replace(/\s+/g, '');
        let connected = false, usedPass = rawPass;
        for (const tryP of cleanPass !== rawPass ? [cleanPass, rawPass] : [rawPass]) {
          const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: p.email, pass: tryP }, logger: false });
          try { await client.connect(); await client.logout().catch(() => {}); connected = true; usedPass = tryP; break; } catch {}
        }
        if (waitMsg) await ctx.api.deleteMessage(waitMsg.chat.id, waitMsg.message_id).catch(() => {});
        if (connected) {
          store.upsertGmail({ email: p.email, owner: String(ctx.from.id), imapPass: usedPass, status: 'active', connectedAt: Date.now() });
          startSingleImap({ user: p.email, pass: usedPass, host: 'imap.gmail.com', owner: String(ctx.from.id) });
          return ctx.reply(`✅ <b>Gmail সফলভাবে যুক্ত হয়েছে!</b>\n📧 <code>${esc(p.email)}</code>`, HTML);
        }
        pending.set(ctx.from.id, { type: 'gm_pass', email: p.email, mode: 'app_pass' });
        const step2Btns = [];
        if (gmailEnabled()) step2Btns.push([btn.url('📲 Google 2FA প্রম্পট ভেরিফাই করুন', gmailAuthUrl(ctx.from.id, p.email, true), 'success')]);
        step2Btns.push([btn.url('🔑 App Password নিন ↗', 'https://myaccount.google.com/apppasswords', 'primary')], [cancelRow]);
        return ctx.reply(
          head('📱', 'ধাপ ৩/৩: 2-Step Verification (2FA)') + `👤 <code>${esc(p.email)}</code>\nনিচের বাটনে ভেরিফাই করুন অথবা App Password দিন:`,
          { ...HTML, reply_markup: rows(...step2Btns) }
        );
      } catch {
        if (waitMsg) await ctx.api.deleteMessage(waitMsg.chat.id, waitMsg.message_id).catch(() => {});
        return ctx.reply('⚠️ লগইন সম্পন্ন হয়নি, আবার চেষ্টা করুন।');
      }
    }

    if (p.type === 'totp_add') {
      await delUserMsg(ctx);
      const added = store.importTotpBulk(ctx.from.id, text);
      if (!added.length) return ctx.reply('⚠️ সঠিক 2FA Secret Key বা otpauth URI দিন।', { ...HTML, reply_markup: rows([cancelRow]) });
      pending.delete(ctx.from.id);
      return showTotpBot(ctx, false);
    }

    if (p.type === 'newname') {
      const [rawLocal, rawDom] = text.split('@');
      const name = cleanName(rawLocal);
      if (name.length < 3) return ctx.reply('⚠️ কমপক্ষে ৩টি বৈধ অক্ষর দিন (a-z, 0-9, . _ -)');
      const dom = rawDom && config.domains.includes(rawDom.toLowerCase()) ? rawDom.toLowerCase() : (p.domain || pickDomain(ctx.from.id));
      const rec = makeAddress(ctx.from.id, dom, name);
      if (!rec) return ctx.reply('⚠️ এই নামটি অন্য কেউ ব্যবহার করছে। অন্য নাম দিন।');
      if (p.promptMsgId) await ctx.api.deleteMessage(ctx.chat.id, p.promptMsgId).catch(() => {});
      await delUserMsg(ctx);
      pending.delete(ctx.from.id);
      return sendGen(ctx, false, dom, name);
    }

    if (p.type === 'label') {
      await delPrompt(ctx, p);
      await delUserMsg(ctx);
      pending.delete(ctx.from.id);
      const a = store.setLabel(p.id, text);
      if (!a) return ctx.reply('❌ অ্যাড্রেস পাওয়া যায়নি।', HTML);
      return ctx.reply(genCard(a), { ...HTML, reply_markup: genKeyboard(a, { multiDomain: config.domains.length > 1 }) });
    }

    if (p.type === 'addr_rename') {
      const [rawLocal, rawDom] = text.split('@');
      const local = cleanName(rawLocal);
      const dom = rawDom && config.domains.includes(rawDom.trim().toLowerCase()) ? rawDom.trim().toLowerCase() : undefined;
      const r = store.renameAddress(ctx.from.id, p.id, { local, domain: dom });
      if (r.error === 'invalid_name') return ctx.reply('⚠️ কমপক্ষে ৩টি বৈধ অক্ষর দিন (a-z, 0-9, . _ -)', { ...HTML, reply_markup: rows([cancelRow]) });
      if (r.error === 'taken') return ctx.reply('⚠️ এই নামটি অন্য কেউ ব্যবহার করছে। অন্য নাম দিন।', { ...HTML, reply_markup: rows([cancelRow]) });
      if (r.error) { pending.delete(ctx.from.id); return ctx.reply('❌ অ্যাড্রেস রিনেম করা যায়নি।', HTML); }
      await delPrompt(ctx, p);
      await delUserMsg(ctx);
      pending.delete(ctx.from.id);
      const rec = r.address;
      const s = await ctx.reply(genCard(rec), { ...HTML, reply_markup: genKeyboard(rec, { multiDomain: config.domains.length > 1 }) }).catch(() => null);
      if (s) store.setActiveCard(ctx.from.id, s.chat.id, s.message_id, rec.addr, false);
      return;
    }

    if (p.type === 'totp_edit') {
      const parts = text.split('|').map((s) => s.trim());
      const name = parts[0] || '';
      const issuer = parts[1] !== undefined ? parts[1] : undefined;
      if (!name) return ctx.reply('⚠️ সঠিক নাম দিন।', { ...HTML, reply_markup: rows([cancelRow]) });
      const upd = store.updateTotp(ctx.from.id, p.id, { name, ...(issuer !== undefined ? { issuer } : {}) });
      await delPrompt(ctx, p);
      await delUserMsg(ctx);
      pending.delete(ctx.from.id);
      if (!upd) return ctx.reply('❌ 2FA এন্ট্রি পাওয়া যায়নি।', HTML);
      return showTotpBot(ctx, false);
    }

    if (p.type === 'broadcast' && isAdmin(ctx.from.id)) {
      pending.set(ctx.from.id, { type: 'broadcast-confirm', text });
      return ctx.reply(`📢 <b>Preview</b>\n${HR}\n${esc(text)}`, { ...HTML, reply_markup: rows([btn.cb('🚀 পাঠান', 'am:bcy', 'success'), cancelRow]) });
    }
  });

  return bot;
}

export async function startBot(bot) {
  const me = await bot.api.getMe();
  bot.botInfo = me;
  console.log(`🤖 Bot @${me.username} চালু হচ্ছে...`);
  await bot.api.setMyCommands([
    { command: 'start', description: '🚀 Start & Workspace' },
    { command: 'gen', description: '⚡ Instant mail [name@domain]' },
    { command: 'custom', description: '🎯 Custom mail address' },
    { command: 'inbox', description: '📬 Inbox & OTP search' },
    { command: 'codes', description: '🔐 Live OTP & 2FA codes' },
    { command: '2fa', description: '🛡 2FA Authenticator Vault' },
    { command: 'add2fa', description: '➕ Import 2FA Secret / URI' },
    { command: 'domain', description: '🌐 Switch mail domain' },
    { command: 'addresses', description: '📮 Active addresses' },
    { command: 'gmail', description: '📧 Gmail Connect & Sync' },
    { command: 'auto2fa', description: '🤖 Google Auto 2FA Bot' },
    { command: 'stats', description: '📊 Activity & Stats' },
    { command: 'settings', description: '⚙️ Preferences & Skins' },
    { command: 'help', description: '💡 Help & Commands' },
  ]).catch(() => {});

  if (config.adminId && !store.getMeta('menuV6Sent')) {
    store.setMeta('menuV6Sent', true);
    bot.api.sendMessage(config.adminId, `⚡ <b>${esc(config.brand)} Studio Active</b>`, { ...HTML, reply_markup: mainMenu(true) }).catch(() => {});
  }
  if (webappUrl()) {
    await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: '🚀 Mail App', web_app: { url: webappUrl() } } }).catch((e) => console.warn('menu button:', e.message));
  } else {
    console.warn('ℹ️ PUBLIC_URL (https) সেট নেই — Mini App বাটন বন্ধ থাকবে।');
  }
  const launchPolling = () => {
    bot.start({ drop_pending_updates: false }).catch((e) => {
      console.warn('⚠️ Bot polling interrupted (' + (e?.message || e) + '), retrying in 5s...');
      const t = setTimeout(launchPolling, 5000);
      t.unref?.();
    });
  };
  launchPolling();
  return me;
}
