import { config, webappUrl } from './config.js';
import { escapeHtml as esc } from './lib/mailparse.js';

const withStyle = (b, style) => (style ? { ...b, style } : b);
export const btn = {
  cb: (text, data, style) => withStyle({ text, callback_data: data }, style),
  copy: (text, value, style) => withStyle({ text, copy_text: { text: String(value).slice(0, 256) } }, style),
  url: (text, url, style) => withStyle({ text, url }, style),
  app: (text, path = '', style) => {
    const base = webappUrl();
    return base ? withStyle({ text, web_app: { url: base + path } }, style) : null;
  },
};

export const rows = (...r) => ({
  inline_keyboard: r.map((x) => (Array.isArray(x) ? x : [x]).filter(Boolean)).filter((x) => x.length),
});

export const fmtTime = (ts) =>
  new Intl.DateTimeFormat('en-US', { timeZone: config.tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ts));

export const fmtDate = (ts) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: config.tz, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(ts));

export const HR = '──────────────';
export const head = (icon, title) => `${icon} <b>${esc(title)}</b>\n${HR}\n`;

export function formatOtpSpaced(code = '') {
  const clean = String(code || '').trim();
  if (clean.length === 6) return `${clean.slice(0, 3)} ${clean.slice(3)}`;
  if (clean.length === 8) return `${clean.slice(0, 4)} ${clean.slice(4)}`;
  return clean;
}

const shortLabel = (l) => {
  const t = String(l.label || '').trim();
  return (t && t.length <= 18 ? t : l.host.split('.').slice(-2, -1)[0] || l.host).slice(0, 18);
};

export const mainLink = (msg) => {
  const ls = msg.links || [];
  return (msg.otp ? ls.filter((l) => l.score >= 3) : ls)[0] || null;
};

function smartContext(msg) {
  const raw = `${msg.purpose || ''} ${msg.subject || ''}`.toLowerCase();
  if (/reset|recover|forgot|পাসওয়ার্ড/.test(raw)) {
    return { pIcon: '🔓', pTitle: 'Password Recovery', cIcon: '🚨', cText: 'Account Recovery Code', lIcon: '🔑', lText: 'Reset Link' };
  }
  if (/login|sign.?in|log.?in|2fa|two.?factor|auth/.test(raw)) {
    return { pIcon: '🛡', pTitle: 'Login Verification', cIcon: '🔑', cText: 'One-Time Passcode', lIcon: '⚡', lText: 'Approve Login' };
  }
  if (/sign.?up|register|welcome|create|activate|confirm|verify|verification/.test(raw)) {
    return { pIcon: '✨', pTitle: esc(msg.purpose || 'Email Verification'), cIcon: '🔐', cText: 'Verification Code', lIcon: '🌐', lText: 'Confirm Email' };
  }
  if (/security|alert|device|suspicious/.test(raw)) {
    return { pIcon: '⚠️', pTitle: 'Security Alert', cIcon: '🛡', cText: 'Security Code', lIcon: '🔍', lText: 'Review Activity' };
  }
  return { pIcon: '📩', pTitle: esc(msg.purpose || 'Incoming Mail'), cIcon: '🔐', cText: 'Verification Code', lIcon: '🔗', lText: 'Open Link' };
}

export function mailCard(msg, rec, style = 'smart') {
  const link = mainLink(msg);
  const ctx = smartContext(msg);
  if (style === 'rich') {
    const codeLine = msg.otp ? `\n${ctx.cIcon} <b>${ctx.cText}:</b> <code>${esc(msg.otp)}</code>` : '';
    const linkLine = link ? `\n${ctx.lIcon} <b>${ctx.lText}:</b> ${esc(shortLabel(link))}` : '';
    const subjLine = !msg.otp && !link && msg.subject ? `\n📝 ${esc(msg.subject.slice(0, 60))}` : '';
    return `📬 <b>New Mail</b> · ${fmtTime(msg.date || Date.now())}\n${HR}\n<code>${esc(msg.to)}</code>\n${msg.service.icon} <b>${esc(msg.service.name)}</b> · ${ctx.pIcon} ${ctx.pTitle}${codeLine}${linkLine}${subjLine}`;
  }
  if (style === 'compact') {
    const info = msg.otp ? `${ctx.cIcon} <b>${ctx.cText}</b> · <code>${esc(msg.otp)}</code>` : link ? `${ctx.lIcon} <b>${ctx.lText}</b>` : `📩 ${esc((msg.subject || msg.purpose || 'New Mail').slice(0, 40))}`;
    return `${msg.service.icon} <b>${esc(msg.service.name)}</b> · <code>${esc(msg.to)}</code>\n${info}`;
  }
  let line3 = `📩 <b>${esc((msg.subject || 'New Incoming Mail').slice(0, 44))}</b>`;
  if (msg.otp && link) line3 = `${ctx.cIcon} <b>${ctx.cText}</b> &amp; ${ctx.lIcon} <b>Verify Link</b>`;
  else if (msg.otp) line3 = `${ctx.cIcon} <b>${ctx.cText}:</b> <code>${esc(msg.otp)}</code>`;
  else if (link) line3 = `${ctx.lIcon} <b>${ctx.lText}</b> · <i>Tap Below</i>`;
  return `<b>${esc(msg.to)}</b>\n${msg.service.icon} <b>${esc(msg.service.name)}</b> · ${ctx.pIcon} <b>${ctx.pTitle}</b>\n${line3}`;
}

export function mailKeyboard(msg, { back = false } = {}) {
  const r = [];
  const first = [];
  if (msg.otp) first.push(btn.copy(`🔒 ${msg.otp}`, msg.otp, 'success'));
  const link = mainLink(msg);
  if (link) first.push(btn.url(`🔗 ${shortLabel(link)} ↗`, link.url, 'primary'));
  if (first.length) r.push(first);
r.push([btn.cb('🔄 Change Name', 'gn', 'primary'), btn.cb('📄 Full Message', `fm:${msg.id}`, 'primary')]);
 if (back) r.push([btn.cb('⬅️ Inbox', 'ib:0')]); 
  return rows(...r);
}

export function fullMessageText(msg) {
  const body = (msg.text || '(empty)').slice(0, 3200);
  const links = msg.links || [];
  let hl = '';
  if (msg.otp) hl += `\n🔐 <b>Code:</b> <code>${esc(msg.otp)}</code>`;
  if (links.length) {
    hl += `\n🔗 <b>Links:</b>\n` +
      links.slice(0, 4).map((l) => `  • <a href="${esc(l.url)}">${esc(l.label || l.host)} ↗</a>`).join('\n');
  }
  return (
    `📄 <b>Message Details</b>\n${HR}\n` +
    `<b>To:</b> <code>${esc(msg.to)}</code>\n<b>From:</b> ${esc(msg.from || '—')}\n` +
    `<b>Subject:</b> ${esc(msg.subject || '(no subject)')}\n<b>Time:</b> ${fmtDate(msg.date)}` +
    (hl ? `\n${HR}${hl}` : '') +
    `\n\n<blockquote expandable>${esc(body)}${msg.text && msg.text.length > 3200 ? '\n…' : ''}</blockquote>`
  );
}

export function fmtLeft(rec = {}) {
  if (rec?.expired) return '⛔ Expired';
  if (!rec?.expiresAt) return '♾ Permanent';
  const mins = Math.max(1, Math.ceil((rec.expiresAt - Date.now()) / 60000));
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `⏳ ${h}h${m ? ` ${m}m` : ''}`;
  }
  return `⏳ ${mins}m left`;
}

export function genCard(rec) {
 return (
   `🚀 <b>Your Instant Disposable Email:</b>\n` +
   `✨ <i>Tap the box below to copy:</i> 👇`
 );
}

export function genKeyboard(rec) {
  return rows(
    [btn.copy(`📋 ${rec.addr}`, rec.addr, 'success')],
    [btn.cb('🔄 Change Name', 'gn', 'primary')]
 );
  

export function totpVaultView(items = [], { isAdmin = false } = {}) {
  const meter = (rem = 30, period = 30) => {
    const filled = Math.max(1, Math.min(6, Math.round((rem / (period || 30)) * 6)));
    return `${rem <= 5 ? '🔴' : rem <= 10 ? '🟡' : '🟢'} ${'●'.repeat(filled)}${'○'.repeat(6 - filled)} ${rem}s`;
  };
  const body = items.length
    ? items.slice(0, 10).map((t) => {
        const star = t.pinned ? '★ ' : '';
        const cat = t.issuer && !t.name.toLowerCase().includes(t.issuer.toLowerCase()) ? ` (${t.issuer})` : '';
        return `${star}<b>${esc(t.name)}${esc(cat)}</b>\n   <code>${formatOtpSpaced(t.code)}</code>  ·  ${meter(t.remaining, t.period)}  ·  Next <code>${formatOtpSpaced(t.nextCode)}</code>`;
      }).join('\n\n')
    : '📭 <i>ভল্টে এখনো কোনো 2FA Key নেই।</i>\n\nনিচের বাটনে ট্যাপ করে <code>Secret</code>, <code>otpauth://</code> বা Google Authenticator Export পেস্ট করুন।';

  const text = head('🛡', '2FA Authenticator Vault') + body;
  const copyRows = items.slice(0, 8).map((t) => [
    btn.copy(`🔑 ${t.name.slice(0, 20)} · ${formatOtpSpaced(t.code)} (${t.remaining}s)`, t.code, 'success'),
    btn.cb(t.pinned ? '★' : '☆', `tf:pin:${t.id}`, t.pinned ? 'success' : 'primary'),
    btn.cb('✏️', `tf:ed:${t.id}`, 'primary'),
    btn.cb('🗑', `tf:del:${t.id}`, 'danger'),
  ]);
  const appBtn = btn.app('🚀 Open 2FA Vault', '?tab=totp', 'success');
  const markup = rows(
    ...copyRows,
    [btn.cb('➕ Add / Import', 'tf:add', 'success'), btn.cb('🔄 Refresh', 'tf:home', 'primary')],
    [btn.cb('🤖 Auto 2FA Bot', 'a2fa:new', 'primary'), ...(appBtn ? [appBtn] : [])],
    ...(isAdmin ? [[btn.cb('⬅️ Admin', 'am:home', 'primary')]] : [])
  );
  return { text, markup };
}

export const SERVICE_COLORS = ['#7c5cff', '#00c2a8', '#ff6b6b', '#ffa94d', '#4dabf7', '#f06595'];
