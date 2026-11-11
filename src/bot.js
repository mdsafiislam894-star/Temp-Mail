import { startSingleImap } from './titan.js';
import { Bot, InputFile } from 'grammy';
import crypto from 'crypto';
import { config, webappUrl, gmailEnabled } from './config.js';
import * as store from './store.js';
import { btn, rows, head, HR, mailCard, mailKeyboard, fullMessageText, genCard, genKeyboard, fmtTime } from './ui.js';

import { escapeHtml as esc } from './lib/mailparse.js';
import { safeSend, sendBotPhoto, initNotify } from './notify.js';
import { startAuto2faJob, performAuto2faAction, getJob, getActiveJobForUser, registerAuto2faBotHook } from './auto2faEngine.js';
import { gmailAuthUrl } from './gmail.js';
import { titanStatus } from './titan.js';

const startedAt = Date.now();
const pending = new Map();
const delUserMsg = async (ctx) => { try { if (ctx.message?.message_id) await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id); } catch {} };
registerAuto2faBotHook((uid, jobId, status) => {
  const numId = Number(uid);
  if (jobId && (status === 'waiting_code' || status === 'waiting_captcha' || status === 'waiting_approval')) {
    pending.set(numId, { type: 'a2fa_input', jobId });
  } else if (!jobId || status === 'completed' || status === 'failed') {
    if (pending.get(numId)?.type === 'a2fa_input') pending.delete(numId);
  }
}); // userId -> { type, ... }
const isAdmin = (id) => String(id) === config.adminId;
const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

const WORDS = ['pulse', 'zenith', 'gohan', 'nova', 'echo', 'flux', 'orbit', 'pixel', 'swift', 'lunar', 'delta', 'blaze', 'vortex', 'nexus', 'omega', 'shadow', 'titan', 'ember', 'comet', 'raven'];
const randomLocal = () => `${WORDS[crypto.randomInt(WORDS.length)]}${crypto.randomInt(1000, 10000)}`;
const cleanName = (s = '') => s.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);

function pickDomain(userId) {
  const u = store.getUser(userId);
  return config.domains[(u?.prefDomain ?? 0) % config.domains.length];
}
/** Random address, or (when `local` is given) exactly that name — null if it is taken by someone else. */
function makeAddress(owner, domain, local) {
return store.generateUniqueAddress(owner, local);
}

const mainMenu = (admin) => ({
  keyboard: [
    [{ text: '⚡ Instant Mail', style: 'success' }],
    [{ text: '🎯 Custom', style: 'primary' }, ...(admin ? [{ text: '👑 Admin', style: 'danger' }] : [])],
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: '⚡ Instant Mail বা 🎯 Custom চাপুন',
});

async function edit(ctx, text, markup) {
try {
const r = await ctx.editMessageText(text, { ...HTML, reply_markup: markup });
if (r?.message_id && ctx.from) store.setActiveCard(ctx.from.id, ctx.chat?.id || ctx.from.id, r.message_id);
} catch (e) {
if (!/not modified/i.test(e.description || e.message || '')) {
const prev = ctx.from && store.getActiveCard(ctx.from.id);
if (prev?.chatId && prev?.messageId) await ctx.api.deleteMessage(prev.chatId, prev.messageId).catch(() => {});
const s = await ctx.reply(text, { ...HTML, reply_markup: markup }).catch(() => null);
if (s && ctx.from) store.setActiveCard(ctx.from.id, s.chat.id, s.message_id);
}
}
}

export function createBot() {
  const bot = new Bot(config.token);
  initNotify(bot);

  bot.catch((err) => console.error('❌ Bot error:', err.error?.description || err.error?.message || err.message));

  // ---------- inline mode: @bot in any chat → insert a code or an address ----------
  bot.on('inline_query', async (ctx) => {
    const u = store.getUser(ctx.from.id);
    if (!u || u.status !== 'approved') {
      return ctx.answerInlineQuery([], { cache_time: 5, is_personal: true, button: { text: '🔒 আগে বটে /start দিন', start_parameter: 'start' } }).catch(() => {});
    }
    const q = (ctx.inlineQuery.query || '').trim().toLowerCase();
    const codes = store.listMessages(u.id, { limit: 60 }).filter((m) => m.otp && (!q || m.service.name.toLowerCase().includes(q))).slice(0, 6);
    const addrs = store.listAddresses(u.id).filter((a) => !a.expired && (!q || a.addr.includes(q))).slice(0, 4);
    const results = [
      ...codes.map((m) => ({ type: 'article', id: `c${m.id}`, title: `🔐 ${m.otp}`, description: `${m.service.name} • ${m.purpose} • ${fmtTime(m.date)}`, input_message_content: { message_text: m.otp } })),
      ...addrs.map((a) => ({ type: 'article', id: `a${a.id}`, title: `📧 ${a.addr}`, description: a.label || 'ঠিকানা পাঠান', input_message_content: { message_text: a.addr } })),
    ];
    await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true, button: results.length ? undefined : { text: '⚡ নতুন মেইল নিন', start_parameter: 'gen' } }).catch(() => {});
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
    return ctx.reply('⏳ <b>Your request was sent to the admins.</b>\nPlease wait for approval.', HTML);
  });

  // auto-answer callbacks (spinner stops) unless a handler already did
  bot.on('callback_query:data', async (ctx, next) => {
    const orig = ctx.answerCallbackQuery.bind(ctx);
    ctx.answerCallbackQuery = (...a) => { ctx._answered = true; return orig(...a); };
    await next();
    if (!ctx._answered) await orig().catch(() => {});
  });

  // ---------- /start ----------
  bot.command('start', async (ctx) => {
pending.delete(ctx.from.id);
const ex = store.listAddresses(ctx.from.id)[0] || makeAddress(ctx.from.id, 'safix.tech');
await ctx.reply('⚡ <b>স্বাগতম!</b> আপনার ডিসপোজেবল মেইল প্রস্তুত:\n<i>নিচের বাটন ব্যবহার করে যেকোনো সময় নতুন মেইল নিতে পারবেন।</i>', { ...HTML, reply_markup: mainMenu(isAdmin(ctx.from.id)) }).catch(() => {});
const s = await ctx.reply(genCard(ex), { ...HTML, reply_markup: genKeyboard(ex, isAdmin(ctx.from.id)) }).catch(() => null);
if (s) store.setActiveCard(ctx.from.id, s.chat.id, s.message_id, ex.addr);
});

  async function quickPanel(ctx, asEdit = false) {
    const id = ctx.from.id;
    const live = store.listAddresses(id).filter((x) => !x.expired).length;
    const act = store.activity(id, 12);
    const max = Math.max(1, ...act);
    const bars = act.map((v) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.round((v / max) * 7))]).join('');
    const n = store.listMessages(id, { limit: 500 }).length;
    const u = store.countUnread(id);
    const text = head('🚀', 'Quick Panel') + `📮 <b>${live}</b> live  •  📬 <b>${n}</b> mails  •  🔵 <b>${u}</b> unread\n<code>${bars}</code> <i>গত ১২ ঘণ্টা</i>`;
    const markup = rows(
      [btn.cb('⚡ Instant Mail', 'gn', 'success'), btn.cb('🔐 Codes', 'cd', 'success')],
      [btn.cb(`📬 Inbox${u ? ` (${u})` : ''}`, 'ib:0', 'primary'), btn.cb('📮 Addresses', 'as', 'primary')],
      [btn.cb('📧 Gmail', 'gm', 'primary'), btn.cb('⚙️ Settings', 'st', 'primary')],
      [btn.app('📱 Open Mail App', '', 'success')]
    );
    return asEdit ? edit(ctx, text, markup) : ctx.reply(text, { ...HTML, reply_markup: markup });
  }
  bot.callbackQuery('qp', (ctx) => quickPanel(ctx, true));

  // ---------- codes vault ----------
  async function codes(ctx, asEdit = false) {
    const list = store.listMessages(ctx.from.id, { limit: 100 }).filter((m) => m.otp).slice(0, 8);
    const text = head('🔐', 'Recent Codes') + (list.length ? 'কোডে ট্যাপ করলেই কপি হবে:' : 'এখনো কোনো কোড আসেনি।');
    const markup = rows(
      ...list.map((m) => [btn.copy(`${m.service.icon} ${m.service.name} · ${m.otp} · ${fmtTime(m.date)}`.slice(0, 60), m.otp, 'success')]),
      [btn.cb('🔄 Refresh', 'cd', 'primary'), btn.cb('🏠 Panel', 'qp', 'primary')]
    );
    return asEdit ? edit(ctx, text, markup) : ctx.reply(text, { ...HTML, reply_markup: markup });
  }
  bot.command('codes', (ctx) => codes(ctx));
  bot.callbackQuery('cd', (ctx) => codes(ctx, true));

  // ---------- address expiry ----------
  bot.callbackQuery(/^tt:(\w+):(\d+)$/, async (ctx) => {
    const rec = store.getAddressById(ctx.match[1]);
    if (!rec || rec.owner !== String(ctx.from.id)) return;
    const mins = Number(ctx.match[2]);
    if (!store.TTLS.includes(mins)) return;
    const upd = store.setExpiry(rec.id, mins);
    await ctx.answerCallbackQuery({ text: mins ? `⏳ মেয়াদ সেট: ${mins >= 60 ? `${mins / 60} ঘণ্টা` : `${mins} মিনিট`}` : '♾ মেয়াদ নেই' });
    await edit(ctx, genCard(upd), genKeyboard(upd));
  });
  bot.callbackQuery(/^ex:(\w+)$/, async (ctx) => {
    const rec = store.getAddressById(ctx.match[1]);
    if (!rec || rec.owner !== String(ctx.from.id)) return;
    const upd = store.extendAddress(rec.id, 60);
    await edit(ctx, genCard(upd), genKeyboard(upd));
  });

  // ---------- mute a service ----------
  bot.callbackQuery(/^mu:(\w+)$/, async (ctx) => {
    const m = getOwned(ctx, ctx.match[1]);
    if (!m) return;
    store.setSettings(ctx.from.id, { mute: m.service.name });
    await ctx.answerCallbackQuery({ text: `🔕 ${m.service.name} মিউট হয়েছে। Settings থেকে আবার চালু করা যাবে।`, show_alert: true });
  });
  bot.callbackQuery(/^um:(\d+)$/, async (ctx) => {
    const name = store.getSettings(ctx.from.id).muted[Number(ctx.match[1])];
    if (name) store.setSettings(ctx.from.id, { unmute: name });
    await showSettings(ctx, true);
  });
  bot.callbackQuery(/^st:skin:(\w+)$/, async (ctx) => { store.setSettings(ctx.from.id, { skin: ctx.match[1] }); await showSettings(ctx, true); });
  bot.callbackQuery(/^st:ttl:(\d+)$/, async (ctx) => { store.setSettings(ctx.from.id, { ttl: Number(ctx.match[1]) }); await showSettings(ctx, true); });

  // ---------- settings ----------
  const onOff = (b) => (b ? '🟢 ON' : '⚪ OFF');
  const TTL_LABEL = { 0: '♾ নেই', 10: '10m', 60: '1h', 1440: '24h' };
  function settingsView(uid) {
    const s = store.getSettings(uid);
    const text = head('⚙️', 'Settings') +
      `🔔 Notifications  <b>${onOff(s.notify)}</b>\n🔐 OTP/Link only  <b>${onOff(s.otpOnly)}</b>\n🎨 Card style  <b>${s.style}</b>\n⏳ নতুন মেইলের মেয়াদ  <b>${TTL_LABEL[s.ttl]}</b>\n🔕 Muted  <b>${s.muted.length}</b>\n📱 App design  <b>${s.skin}</b> • theme <b>${s.theme}</b>`;
    const markup = rows(
      [btn.cb(`🔔 Notifications: ${s.notify ? 'ON' : 'OFF'}`, 'st:notify', s.notify ? 'success' : 'danger')],
      [btn.cb(`🔐 OTP/Link only: ${s.otpOnly ? 'ON' : 'OFF'}`, 'st:otp', s.otpOnly ? 'success' : 'primary')],
      ['smart', 'rich', 'compact'].map((x) => btn.cb(`${s.style === x ? '✅ ' : ''}${x}`, `st:style:${x}`, s.style === x ? 'success' : 'primary')),
      store.TTLS.map((m) => btn.cb(`${s.ttl === m ? '✅' : '⏳'} ${TTL_LABEL[m].replace('♾ নেই', '♾')}`, `st:ttl:${m}`, s.ttl === m ? 'success' : 'primary')),
      ...s.muted.slice(0, 6).map((n, i) => [btn.cb(`🔔 ${n} — আনমিউট`, `um:${i}`, 'danger')]),
      [btn.cb('✅ সব পঠিত', 'st:read', 'primary'), btn.cb('🧹 Inbox খালি', 'st:clr', 'danger')],
      [{ k: 'glass', l: '🍎 Glass' }, { k: 'claude', l: '🟠 Claude' }, { k: 'mix', l: '✨ Mix' }].map((x) => btn.cb(`${s.skin === x.k ? '✅ ' : ''}${x.l}`, `st:skin:${x.k}`, s.skin === x.k ? 'success' : 'primary')),
      [btn.app('🎨 থিম ও ডিজাইন (Mini App)', '?tab=settings', 'success')],
      [btn.cb('⬅️ Back', 'qp')]
    );
    return { text, markup };
  }
  const showSettings = (ctx, asEdit) => {
    const v = settingsView(ctx.from.id);
    return asEdit ? edit(ctx, v.text, v.markup) : ctx.reply(v.text, { ...HTML, reply_markup: v.markup });
  };
  bot.command('settings', (ctx) => showSettings(ctx));
  
  bot.callbackQuery('st', (ctx) => showSettings(ctx, true));
  bot.callbackQuery('st:notify', async (ctx) => { store.setSettings(ctx.from.id, { notify: !store.getSettings(ctx.from.id).notify }); await showSettings(ctx, true); });
  bot.callbackQuery('st:otp', async (ctx) => { store.setSettings(ctx.from.id, { otpOnly: !store.getSettings(ctx.from.id).otpOnly }); await showSettings(ctx, true); });
  bot.callbackQuery(/^st:style:(\w+)$/, async (ctx) => { store.setSettings(ctx.from.id, { style: ctx.match[1] }); await showSettings(ctx, true); });
  bot.callbackQuery('st:read', async (ctx) => { const n = store.markAllRead(ctx.from.id); await ctx.answerCallbackQuery({ text: `✅ ${n}টি পঠিত করা হয়েছে` }); });
  bot.callbackQuery('st:clr', (ctx) => edit(ctx, '🧹 <b>ইনবক্সের সব মেসেজ মুছে ফেলবেন?</b>', rows([btn.cb('✅ হ্যাঁ, মুছুন', 'st:clry', 'danger'), btn.cb('↩️ না', 'st', 'success')])));
  bot.callbackQuery('st:clry', async (ctx) => { const n = store.clearMessages(ctx.from.id); await ctx.answerCallbackQuery({ text: `🧹 ${n}টি মুছে গেছে` }); await showSettings(ctx, true); });

  bot.command('myid', (ctx) => ctx.reply(`🆔 Chat ID: <code>${ctx.chat.id}</code>`, HTML));
  bot.command('help', (ctx) => ctx.reply('/gen /custom /inbox /addresses /gmail /cancel', HTML));
  bot.command('cancel', (ctx) => { pending.delete(ctx.from.id); return ctx.reply('✖️ বাতিল করা হয়েছে।'); });
  const cancelRow = btn.cb('✖️ Cancel', 'cx', 'danger');
  bot.callbackQuery('cx', async (ctx) => { pending.delete(ctx.from.id); await edit(ctx, '✖️ বাতিল করা হয়েছে।', undefined); });

  // ---------- generate ----------
  async function sendGen(ctx, asEdit = false, domain = 'safix.tech', local) {
if (ctx.message?.message_id && ctx.chat?.id) {
await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
}
const prev = store.getActiveCard(ctx.from.id);
if (prev?.chatId && prev?.messageId) {
await ctx.api.deleteMessage(prev.chatId, prev.messageId).catch(() => {});
}
const rec = makeAddress(ctx.from.id, 'safix.tech', local);
if (!rec) return ctx.reply('⚠️ এই নামটি অন্য কেউ ব্যবহার করছে। অন্য নাম দিন।', { reply_markup: mainMenu(isAdmin(ctx.from.id)) });
const opts = genKeyboard(rec, isAdmin(ctx.from.id));
if (asEdit) return edit(ctx, genCard(rec), opts);
const s = await ctx.reply(genCard(rec), { ...HTML, reply_markup: opts }).catch(() => null);
if (s) store.setActiveCard(ctx.from.id, s.chat.id, s.message_id, rec.addr);
}
  bot.command('gen', (ctx) => sendGen(ctx));
  bot.hears(['⚡ Instant Mail', '⚡ Instant Mail (/gen)'], (ctx) => sendGen(ctx));
  bot.callbackQuery('gn', (ctx) => sendGen(ctx, true));

  bot.callbackQuery('gd', async (ctx) => {
    if (config.domains.length < 2) return ctx.answerCallbackQuery({ text: 'শুধু একটি ডোমেইন যুক্ত আছে', show_alert: true });
    const cur = pickDomain(ctx.from.id);
    await edit(
      ctx,
      head('🌐', 'ডোমেইন বাছাই করুন') + 'নতুন মেইল যে ডোমেইনে তৈরি হবে:',
      rows(...config.domains.map((d, i) => [btn.cb(`${d === cur ? '✅' : '🌐'} ${d}`, `gs:${i}`, d === cur ? 'success' : 'primary')]), [btn.cb('⬅️ Back', 'gn')])
    );
  });
  bot.callbackQuery(/^gs:(\d+)$/, async (ctx) => {
    const i = Number(ctx.match[1]);
    if (i >= config.domains.length) return;
    store.setPrefDomain(ctx.from.id, i);
    await sendGen(ctx, true, config.domains[i]);
  });

  // ---------- custom / change name ----------
  async function askName(ctx, domain = 'safix.tech', prompt = '🎯 <b>কাস্টম নাম লিখুন</b>') {
if (ctx.message?.message_id && ctx.chat?.id) await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
const oldP = pending.get(ctx.from.id);
if (oldP?.promptMsgId && ctx.chat?.id) await ctx.api.deleteMessage(ctx.chat.id, oldP.promptMsgId).catch(() => {});
const pm = await ctx.reply(`${prompt}\n<i>a-z, 0-9, . _ - (কমপক্ষে ৩ অক্ষর) — @safix.tech</i>`, { ...HTML, reply_markup: rows([cancelRow]) }).catch(() => null);
pending.set(ctx.from.id, { type: 'newname', domain: 'safix.tech', promptMsgId: pm?.message_id });
}
  bot.command('custom', async (ctx) => {
    const arg = cleanName(ctx.match || '');
    if (arg.length >= 3) return sendGen(ctx, false, pickDomain(ctx.from.id), arg);
    return askName(ctx, pickDomain(ctx.from.id));
  });
  bot.hears('🎯 Custom', (ctx) => askName(ctx, pickDomain(ctx.from.id)));
  bot.callbackQuery(/^cn:(\w+)$/, (ctx) => sendGen(ctx, true));

  // ---------- labels ----------
  bot.callbackQuery(/^rl:(\w*):(\w*)$/, async (ctx) => {
    let rec = ctx.match[1] && ctx.match[1] !== 'x' ? store.getAddressById(ctx.match[1]) : null;
    if (!rec && ctx.match[2]) {
      const m = store.getMessage(ctx.match[2]);
      if (m && m.owner === String(ctx.from.id)) rec = store.ensureAddress(m.owner, m.to);
    }
    if (!rec || rec.owner !== String(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'এই অ্যাড্রেসটি আপনার নয়', show_alert: true });
    pending.set(ctx.from.id, { type: 'label', id: rec.id });
    await ctx.reply(`🏷 <code>${esc(rec.addr)}</code>\nএর জন্য একটি লেবেল/নাম লিখুন (যেমন: Netflix, Work):`, { ...HTML, reply_markup: rows([cancelRow]) });
  });

  // ---------- messages ----------
  const getOwned = (ctx, id) => {
    const m = store.getMessage(id);
    return m && m.owner === String(ctx.from.id) ? m : null;
  };
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
      [m.html ? btn.cb('📎 HTML ফাইল', `fh:${m.id}`, 'primary') : null],
      [m.otp ? btn.copy(`🔒 ${m.otp}`, m.otp, 'success') : null], [btn.cb('⬅️ Back', `mm:${m.id}`, 'primary'), btn.cb('🔄 Change Name', 'gn', 'primary')]
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
  async function inbox(ctx, offset = 0, asEdit = false) {
    const all = store.listMessages(ctx.from.id, { limit: 200 });
    const page = all.slice(offset, offset + 8);
    const unread = store.countUnread(ctx.from.id);
    let text = head('📬', 'Inbox') + (all.length ? `মোট <b>${all.length}</b> • অপঠিত <b>${unread}</b>` : '📭 এখনো কোনো মেসেজ আসেনি।\n<i>/gen দিয়ে মেইল নিয়ে কোনো সাইটে ব্যবহার করুন।</i>');
    const list = page.map((m) => [
      btn.cb(`${m.read ? '' : '🔵 '}${m.service.icon} ${m.service.name} • ${(m.otp || m.purpose).slice(0, 22)}  ${fmtTime(m.date)}`.slice(0, 60), `mo:${m.id}`, m.read ? undefined : 'primary'),
    ]);
    const nav = [];
    if (offset > 0) nav.push(btn.cb('⬅️ Prev', `ib:${Math.max(0, offset - 8)}`));
    if (offset + 8 < all.length) nav.push(btn.cb('Next ➡️', `ib:${offset + 8}`));
    const markup = rows(...list, nav, [btn.cb('🔄 Refresh', `ib:${offset}`, 'success'), btn.cb('✅ সব পঠিত', `ra:${offset}`, 'primary'), btn.cb('🏠', 'qp')]);
    return asEdit ? edit(ctx, text, markup) : ctx.reply(text, { ...HTML, reply_markup: markup });
  }
  bot.command('inbox', (ctx) => inbox(ctx));
  bot.hears(['📬 Inbox', '📮 My Addresses', '📧 Gmail', '⚙️ Settings'], (ctx) => ctx.reply('📱 এই অপশনটি এখন Mini App-এর ভেতর রয়েছে। নিচের বাটনগুলো ব্যবহার করুন:', { reply_markup: mainMenu(isAdmin(ctx.from.id)) }));
  bot.callbackQuery(/^ib:(\d+)$/, (ctx) => inbox(ctx, Number(ctx.match[1]), true));
  bot.callbackQuery(/^ra:(\d+)$/, async (ctx) => { store.markAllRead(ctx.from.id); await inbox(ctx, Number(ctx.match[1]), true); }); 

  // ---------- addresses ----------
  async function addresses(ctx, asEdit = false) {
    const list = store.listAddresses(ctx.from.id).filter((a) => !a.expired).slice(0, 12);
    const text = head('📮', 'My Addresses') + (list.length ? 'একটিতে ট্যাপ করে ম্যানেজ করুন:' : 'এখনো কোনো অ্যাড্রেস নেই। /gen চাপুন।');
    const markup = rows(...list.map((a) => [btn.cb(`📧 ${a.label ? `${a.label} • ` : ''}${a.addr}`.slice(0, 60), `av:${a.id}`, 'primary')]), [btn.cb('⚡ Instant Mail', 'gn', 'success')]);
    return asEdit ? edit(ctx, text, markup) : ctx.reply(text, { ...HTML, reply_markup: markup });
  }
  bot.command('addresses', (ctx) => addresses(ctx));
  
  bot.callbackQuery('as', (ctx) => addresses(ctx, true));
  bot.callbackQuery(/^av:(\w+)$/, async (ctx) => {
    const a = store.getAddressById(ctx.match[1]);
    if (!a || a.owner !== String(ctx.from.id)) return edit(ctx, '❌ পাওয়া যায়নি।', undefined);
    await edit(ctx, head('📧', 'Address') + `<code>${esc(a.addr)}</code>${a.label ? `\n🏷 <i>${esc(a.label)}</i>` : ''}`, rows(
      [btn.copy('📋 Copy', a.addr, 'success'), btn.cb('🏷 Label', `rl:${a.id}:`, 'primary')],
      [btn.cb('🗑 Delete', `ad:${a.id}`, 'danger'), btn.cb('⬅️ Back', 'as')]
    ));
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
const text = head('📧', 'Gmail Connect & Live OTP') + (list.length ? list.map((g) => `${stateIcon(g)} <code>${esc(g.email)}</code>`).join('\n') : 'কোনো Gmail যুক্ত নেই।') + '\n\n👇 <b>যেকোনো একটি পদ্ধতিতে আপনার Gmail লগইন করুন:</b>';
const markup = rows(
[gmailEnabled() ? btn.url('🟢 Continue with Gmail', gmailAuthUrl(ctx.from.id), 'success') : btn.cb('🟢 Continue with Gmail', 'ga', 'success')],
[btn.cb('📱 Email + Password লগইন (2FA)', 'gm:phone', 'primary')],
[btn.cb('🔑 Email + App Password লগইন', 'gm:app', 'primary')],
...list.map((g, i) => [btn.cb(`🗑 ${g.email}`, `gx:${i}`, 'danger')])
);
return asEdit ? edit(ctx, text, markup) : ctx.reply(text, { ...HTML, reply_markup: markup });
}
bot.command('gmail', (ctx) => gmailHome(ctx));
bot.callbackQuery('gm', (ctx) => gmailHome(ctx, true));
bot.callbackQuery('ga', async (ctx) => {
if (gmailEnabled()) return edit(ctx, head('🟢', 'Continue with Gmail') + 'নিচের বাটনে ট্যাপ করে আপনার Google অ্যাকাউন্ট সিলেক্ট করুন:', rows([btn.url('🟢 Continue with Gmail', gmailAuthUrl(ctx.from.id), 'success')], [btn.cb('⬅️ Back', 'gm')]));
return edit(ctx, head('📱', 'Gmail লগইন') + 'নিচের বাটন থেকে ইমেইল ও পাসওয়ার্ড (2FA) অথবা App Password দিয়ে লগইন করুন:', rows([btn.cb('📱 Email + Password (2FA)', 'gm:phone', 'primary')], [btn.cb('🔑 Email + App Password', 'gm:app', 'success')], [btn.cb('⬅️ Back', 'gm')]));
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

  // ---------- 2FA Authenticator in Bot ----------
  async function showTotpBot(ctx, asEdit = false) {
    const items = store.listTotp(ctx.from.id);
    const lines = items.length
      ? items.map((t, i) => `${i + 1}. 🔐 <b>${esc(t.name)}</b>\n   📟 কোড: <code>${t.code}</code> (⏳ ${t.remaining}s) • পরবর্তী: <code>${t.nextCode}</code>`).join('\n\n')
      : '📭 এখনো কোনো 2FA Secret Key যুক্ত করা হয়নি।\n\n<i>নিচের বাটনে ট্যাপ করে যেকোনো ১৬ বা ৩২ ডিজিটের 2FA কোড যুক্ত করুন — Google Authenticator ও 2fa.cn-এর মতো লাইভ কোড দেখাবে!</i>';
    const text = head('🔐', 'Live 2FA Authenticator') + lines;
    const markup = rows(
      ...items.slice(0, 8).map((t) => [
        btn.copy(`🔐 ${t.name}: ${t.code} (${t.remaining}s)`, t.code, 'success'),
        btn.cb('🗑', `tf:del:${t.id}`, 'danger'),
      ]),
      [btn.cb('➕ নতুন 2FA Key যোগ করুন', 'tf:add', 'success'), btn.cb('🔄 লাইভ কোড রিফ্রেশ', 'tf:home', 'primary')],
      [btn.app('📱 অ্যাপে লাইভ 2FA দেখুন', '?tab=admin&sub=totp', 'primary')],
      ...(isAdmin(ctx.from.id) ? [[btn.cb('⬅️ Admin Panel', 'am:home')]] : [])
    );
    return asEdit ? edit(ctx, text, markup) : ctx.reply(text, { ...HTML, reply_markup: markup });
  }
  bot.command('2fa', (ctx) => showTotpBot(ctx));
  bot.callbackQuery('tf:home', (ctx) => showTotpBot(ctx, true));
  bot.callbackQuery('totp:list', (ctx) => showTotpBot(ctx, true));
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
    return ctx.reply(head('🤖', 'ফুল অটোমেটিক Gmail 2FA বট') + 'আপনার Gmail এবং Password নিচের ফরম্যাটে পাঠান:\n<code>example@gmail.com | your_password</code>', { ...HTML, reply_markup: rows([cancelRow]) });
  });
  bot.callbackQuery('a2fa:new', async (ctx) => {
    pending.set(ctx.from.id, { type: 'a2fa_start' });
    await edit(ctx, head('🤖', 'ফুল অটোমেটিক Gmail 2FA বট') + 'আপনার Gmail এবং Password নিচের ফরম্যাটে পাঠান:\n<code>example@gmail.com | your_password</code>', rows([cancelRow]));
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
        await sendBotPhoto(ctx.from.id, r.job.screenshot, `🔄 <b>বিকল্প ভেরিফিকেশন অপশন (${esc(r.job.email)}):</b>`, rows(...optRows, [btn.cb('✅ কন্টিনিউ', `a2fa:cont:${jobId}`, 'success')], [btn.cb('🛑 বাতিল', `a2fa:stop:${jobId}`, 'danger')]));
      }
      return;
    }
    if (act === 'snap') {
      await ctx.answerCallbackQuery({ text: '📸 স্ক্রিনশট নেওয়া হচ্ছে…' });
      const r = await performAuto2faAction(jobId, { action: 'snap' });
      if (r.ok && r.job?.screenshot) {
        await sendBotPhoto(ctx.from.id, r.job.screenshot, `📸 <b>লাইভ ব্রাউজার স্ক্রিন (${esc(r.job.email)})</b>`, rows([btn.cb('✅ কন্টিনিউ', `a2fa:cont:${jobId}`, 'success'), btn.cb('🔄 রিফ্রেশ', `a2fa:snap:${jobId}`)], [btn.cb('🛑 বাতিল', `a2fa:stop:${jobId}`, 'danger')]));
      }
    }
  });
  bot.callbackQuery(/^a2fa:opt:([^:]+):(\d+)$/, async (ctx) => {
    const [, jobId, idx] = ctx.match;
    await ctx.answerCallbackQuery({ text: '👉 অপশন সিলেক্ট করা হচ্ছে…' });
    const r = await performAuto2faAction(jobId, { action: 'option', optionIdx: Number(idx) });
    if (r.ok && r.job?.screenshot) {
      pending.set(ctx.from.id, { type: 'a2fa_input', jobId });
      await sendBotPhoto(ctx.from.id, r.job.screenshot, `✍️ <b>${esc(r.job.email)}</b>: কোড বা রিকভারি তথ্য সরাসরি এখানে লিখে পাঠান:`, rows([btn.cb('✅ কন্টিনিউ', `a2fa:cont:${jobId}`, 'success')], [btn.cb('🛑 বাতিল', `a2fa:stop:${jobId}`, 'danger')]));
    }
  });
  bot.callbackQuery('tf:add', async (ctx) => {
    pending.set(ctx.from.id, { type: 'totp_add' });
    await edit(
      ctx,
      head('➕', 'নতুন 2FA Secret যোগ করুন') +
        'আপনার অ্যাকাউন্টের নাম এবং ১৬ বা ৩২ ডিজিটের 2FA Secret Key পাঠান:\n\n' +
        'উদাহরণ ১: <code>Google | JBSWY3DPEHPK3PXP</code>\n' +
        'উদাহরণ ২ (শুধু কোড): <code>JBSWY3DPEHPK3PXP</code>',
      rows([cancelRow])
    );
  });
  bot.callbackQuery(/^tf:del:(\w+)$/, async (ctx) => {
    store.removeTotp(ctx.from.id, ctx.match[1]);
    await ctx.answerCallbackQuery({ text: '🗑 2FA মুছে ফেলা হয়েছে' });
    await showTotpBot(ctx, true);
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
      `📮 Addresses <b>${s.addresses}</b>  📬 Mails <b>${s.messages}</b>  📅 আজ <b>${s.today}</b>\n` +
      `📧 Gmail <b>${s.gmail}</b>  🖥 Titan <b>${t.online}/${t.total}</b>\n` +
      `${config.openAccess ? '🔓 Access: <b>Open</b>' : '🔒 Access: <b>Approval</b>'}  ⏱ <b>${Math.floor(up / 60)}h ${up % 60}m</b>`
    );
  }
  const adminMarkup = () => rows(
    [btn.cb('🔐 2FA Authenticator (Live)', 'tf:home', 'success')],
    [btn.cb('👥 Users', 'am:users:0', 'primary'), btn.cb(`⏳ Pending (${store.stats().pending})`, 'am:pend', 'primary')],
    [btn.cb('📢 Broadcast', 'am:bc', 'success'), btn.cb(config.openAccess ? '🔒 Approval চালু করুন' : '🔓 Open Access', 'am:access', config.openAccess ? 'danger' : 'primary')],
    [btn.app('🛰 Open Control Panel', '?tab=admin', 'success'), btn.cb('🔄 Refresh', 'am:home', 'primary')]
  );
  bot.callbackQuery('am:access', async (ctx) => {
    if (!adminOnly(ctx)) return;
    config.openAccess = !config.openAccess;
    store.setMeta('openAccess', config.openAccess);
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
    if (off > 0) nav.push(btn.cb('⬅️', `am:users:${off - 8}`));
    if (off + 8 < all.length) nav.push(btn.cb('➡️', `am:users:${off + 8}`));
    await edit(ctx, head('👥', 'Users') + `মোট ${all.length}`, rows(...all.slice(off, off + 8).map((u) => [btn.cb(`${stIcon[u.status]} ${u.name}`.slice(0, 50), `am:u:${u.id}`, u.status === 'banned' ? 'danger' : undefined)]), nav, [btn.cb('⬅️ Back', 'am:home')]));
  });
  bot.callbackQuery(/^am:u:(\d+)$/, async (ctx) => {
    if (!adminOnly(ctx)) return;
    const u = store.getUser(ctx.match[1]);
    if (!u) return;
    await edit(ctx, head('👤', u.name) + `🆔 <code>${u.id}</code>${u.username ? `\n@${esc(u.username)}` : ''}\nStatus: ${stIcon[u.status]} <b>${u.status}</b>\n📮 ${store.listAddresses(u.id).length} addresses`, rows(
      [u.status === 'banned' ? btn.cb('♻️ Unban', `am:ok:${u.id}`, 'success') : btn.cb('⛔ Ban', `am:ban:${u.id}`, 'danger')],
      [btn.cb('⬅️ Back', 'am:users:0')]
    ));
  });
  bot.callbackQuery('am:pend', async (ctx) => {
    if (!adminOnly(ctx)) return;
    const p = store.listUsers().filter((u) => u.status === 'pending');
    await edit(ctx, head('⏳', 'Pending Requests') + (p.length ? '' : 'কোনো পেন্ডিং রিকোয়েস্ট নেই।'), rows(...p.map((u) => [btn.cb(`✅ ${u.name}`.slice(0, 30), `am:ok:${u.id}`, 'success'), btn.cb('⛔', `am:no:${u.id}`, 'danger')]), [btn.cb('⬅️ Back', 'am:home')]));
  });
  bot.callbackQuery(/^am:(ok|no|ban):(\d+)$/, async (ctx) => {
    if (!adminOnly(ctx)) return;
    const [, act, id] = ctx.match;
    const u = store.setUserStatus(id, act === 'ok' ? 'approved' : 'banned');
    if (!u) return;
    if (act === 'ok') {
      await safeSend(id, '✅ <b>Your access request was accepted.</b>\n\n⚡ শুরু করতে /start চাপুন।', undefined);
    }
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

  // ---------- free-text (pending actions) ----------
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
    let p = pending.get(ctx.from.id);
    if (!p) {
      const activeJob = getActiveJobForUser(ctx.from.id);
      if (activeJob && (activeJob.status === 'waiting_code' || activeJob.status === 'waiting_captcha' || activeJob.status === 'waiting_approval')) {
        p = { type: 'a2fa_input', jobId: activeJob.id };
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
      await ctx.reply('⚡ আপনার দেওয়া কোড/তথ্য অটো 2FA বটে পাঠানো হয়েছে — ভেরিফাই করা হচ্ছে…', HTML);
      await performAuto2faAction(p.jobId, { action: 'input', text });
      return;
    }
        if (p.type === 'gm_email') {
const email = text.toLowerCase().trim();
if (!email.includes('@')) return ctx.reply('⚠️ সঠিক Gmail ঠিকানা লিখুন (যেমন: example@gmail.com)');
await delUserMsg(ctx);
pending.set(ctx.from.id, { type: 'gm_pass', email, mode: p.mode });
const msgTxt = p.mode === 'app_pass' ? head('🔑', 'ধাপ ২/২: App Password দিন') + `👤 <code>${esc(email)}</code>\nআপনার ১৬-অক্ষরের <b>Google App Password</b> লিখে পাঠান:` : head('🔐', 'ধাপ ২/৩: পাসওয়ার্ড দিন') + `👤 <code>${esc(email)}</code>\nআপনার <b>Gmail পাসওয়ার্ড</b> লিখে পাঠান:`;
return ctx.reply(msgTxt, { ...HTML, reply_markup: rows([btn.url('🔗 2FA App Password নিন ↗', 'https://myaccount.google.com/apppasswords', 'primary')], [cancelRow]) });
}
if (p.type === 'gm_pass') {
const rawPass = text.trim(); await delUserMsg(ctx); pending.delete(ctx.from.id);
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
return ctx.reply(`✅ <b>Gmail সফলভাবে যুক্ত হয়েছে!</b>\n📧 <code>${esc(p.email)}</code>\nএখন থেকে এই মেইলের সব OTP ও লিংক সাথে সাথে এখানে আসবে।`, HTML);
}
pending.set(ctx.from.id, { type: 'gm_pass', email: p.email, mode: 'app_pass' });
const step2Btns = [];
if (gmailEnabled()) step2Btns.push([btn.url('📲 ফোনে Google 2FA প্রম্পট ভেরিফাই করুন', gmailAuthUrl(ctx.from.id, p.email, true), 'success')]);
step2Btns.push([btn.url('🔑 Google 2FA কোড / App Password নিন ↗', 'https://myaccount.google.com/apppasswords', 'primary')], [cancelRow]);
return ctx.reply(head('📱', 'ধাপ ৩/৩: 2-Step Verification (2FA)') + `👤 <code>${esc(p.email)}</code>\nআপনার অ্যাকাউন্টে <b>2-Step Verification (2FA)</b> চালু আছে।\n১) নিচের বাটনে ট্যাপ করে ফোনে <b>2FA ভেরিফাই</b> করুন, অথবা\n২) ১৬-অক্ষরের <b>2FA App Password কোডটি</b> এখানে লিখে পাঠান:`, { ...HTML, reply_markup: rows(...step2Btns) });
} catch { if (waitMsg) await ctx.api.deleteMessage(waitMsg.chat.id, waitMsg.message_id).catch(() => {}); return ctx.reply('⚠️ লগইন সম্পন্ন হয়নি, আবার চেষ্টা করুন।'); }
}
        if (p.type === 'totp_add') {
      await delUserMsg(ctx);
      let name = '2FA Account', sec = text;
      if (text.includes('|')) {
        const parts = text.split('|');
        name = parts[0].trim() || '2FA Account';
        sec = parts.slice(1).join('|').trim();
      } else if (text.includes(':')) {
        const parts = text.split(':');
        name = parts[0].trim() || '2FA Account';
        sec = parts.slice(1).join(':').trim();
      }
      const item = store.addTotp(ctx.from.id, name, sec);
      if (!item) return ctx.reply('⚠️ সঠিক ১৬ বা ৩২ ডিজিটের 2FA Secret Key দিন।', { ...HTML, reply_markup: rows([cancelRow]) });
      pending.delete(ctx.from.id);
      return showTotpBot(ctx, false);
    }
    if (p.type === 'newname') {
      const name = cleanName(text);
      if (name.length < 3) return ctx.reply('⚠️ কমপক্ষে ৩টি বৈধ অক্ষর দিন (a-z, 0-9, . _ -)');
      const rec = makeAddress(ctx.from.id, p.domain, name);
      if (!rec) return ctx.reply('⚠️ এই নামটি অন্য কেউ ব্যবহার করছে। অন্য নাম দিন।');
      if (p.promptMsgId) await ctx.api.deleteMessage(ctx.chat.id, p.promptMsgId).catch(() => {});
await delUserMsg(ctx);
pending.delete(ctx.from.id);
return sendGen(ctx, false, 'safix.tech', name);
    }
    if (p.type === 'label') {
      pending.delete(ctx.from.id);
      const a = store.setLabel(p.id, text);
      return ctx.reply(a ? `🏷 লেবেল সেট হয়েছে: <b>${esc(a.label)}</b>` : '❌ অ্যাড্রেস পাওয়া যায়নি।', HTML);
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
{ command: 'start', description: '🚀 Start & Instant Mail' },
{ command: 'gen', description: '⚡ Instant disposable mail' },
{ command: 'custom', description: '🎯 Custom name mail' },
{ command: 'admin', description: '👑 Admin panel' },
]).catch(() => {});
if (config.adminId && !store.getMeta('v7MenuSent')) {
store.setMeta('v7MenuSent', true);
bot.api.sendMessage(config.adminId, '⚡ <b>Bot & Titan Mail Ready!</b>', { ...HTML, reply_markup: mainMenu(true) }).catch(() => {});
}
  if (webappUrl()) {
    await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: '🚀 Mail App', web_app: { url: webappUrl() } } }).catch((e) => console.warn('menu button:', e.message));
  } else {
    console.warn('ℹ️ PUBLIC_URL (https) সেট নেই — Mini App বাটন বন্ধ থাকবে।');
  }
  const launchPolling = () => {
    bot.start({ drop_pending_updates: false }).catch((e) => {
      console.warn('⚠️ Bot polling interrupted (' + (e?.message || e) + '), retrying in 5s...');
      setTimeout(launchPolling, 5000);
    });
  };
  launchPolling();
  return me;
}
