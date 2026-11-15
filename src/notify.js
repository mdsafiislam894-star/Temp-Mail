import { config } from './config.js';
import * as store from './store.js';
import { analyze } from './lib/mailparse.js';
import { mailCard, mailKeyboard, mainLink } from './ui.js';
import { emitUserEvent } from './events.js';

let botApi = null;
export const initNotify = (bot) => { botApi = bot.api; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripTags = (s) => s.replace(/<[^>]+>/g, '');

/** Send with automatic fallbacks so one bad button / entity never loses an OTP. */
export async function safeSend(chatId, text, markup) {
  if (!botApi) throw new Error('bot not ready');
  const attempts = [
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup },
    // bad URL button? drop url buttons, keep the rest
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup && stripUrlButtons(markup) },
    { link_preview_options: { is_disabled: true }, reply_markup: markup && stripUrlButtons(markup), plain: true },
  ];
  let lastErr;
  for (const opt of attempts) {
    const { plain, ...extra } = opt;
    try {
      return await botApi.sendMessage(chatId, plain ? stripTags(text) : text, extra);
    } catch (e) {
      lastErr = e;
      if (e.error_code === 429) {
        await sleep(((e.parameters?.retry_after) || 2) * 1000 + 200);
        try { return await botApi.sendMessage(chatId, text, extra); } catch (e2) { lastErr = e2; }
      }
      if (e.error_code === 403) break; // user blocked the bot
    }
  }
  console.error('❌ send failed:', lastErr?.description || lastErr?.message);
  return null;
}


export async function sendBotPhoto(chatId, dataUriOrBase64, caption, markup) {
  if (!botApi) return null;
  try {
    const raw = String(dataUriOrBase64 || '').replace(/^data:image\/\w+;base64,/, '');
    if (!raw) return await safeSend(chatId, caption, markup);
    const buf = Buffer.from(raw, 'base64');
    const { InputFile } = await import('grammy');
    return await botApi.sendPhoto(chatId, new InputFile(buf, 'auto2fa_screen.jpg'), {
      caption: String(caption || '').slice(0, 1020),
      parse_mode: 'HTML',
      reply_markup: markup,
    });
  } catch (e) {
    return await safeSend(chatId, caption, markup);
  }
}

export function stripUrlButtons(markup) {
  return {
    inline_keyboard: markup.inline_keyboard
      .map((row) => row.filter((b) => !b.url))
      .filter((row) => row.length),
  };
}

const addrCards = new Map();
export async function safeLiveUpdate(userId, text, markup, msg = null) {
  const active = store.getActiveCard(userId);
  const msgTo = String(msg?.to || '').toLowerCase();
  const byAddr = msgTo ? addrCards.get(`${userId}:${msgTo}`) : null;
  const target = (byAddr && byAddr.chatId && byAddr.messageId)
    ? byAddr
    : (active && active.chatId && active.messageId && (!active.received || !active.addr || active.addr === msgTo) ? active : null);
  if (botApi && target && target.chatId && target.messageId) {
    try { await botApi.editMessageText(target.chatId, target.messageId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: markup }); if (msgTo) addrCards.set(`${userId}:${msgTo}`, { chatId: target.chatId, messageId: target.messageId }); if (store.markActiveCardReceived) store.markActiveCardReceived(userId, msgTo); return; } catch (e) {
      if (/not modified/i.test(e.description || e.message || '')) return; if (markup) { try { await botApi.editMessageText(target.chatId, target.messageId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: stripUrlButtons(markup) }); if (msgTo) addrCards.set(`${userId}:${msgTo}`, { chatId: target.chatId, messageId: target.messageId }); if (store.markActiveCardReceived) store.markActiveCardReceived(userId, msgTo); return; } catch {} } } }
  const sent = await safeSend(userId, text, markup); if (sent) { if (msgTo) addrCards.set(`${userId}:${msgTo}`, { chatId: userId, messageId: sent.message_id }); store.setActiveCard(userId, userId, sent.message_id, msgTo, true); } }

export async function notifyMessage(msg) {
  const user = store.getUser(msg.owner);
  if (user && user.status !== 'approved') return;
  const st = store.getSettings(msg.owner);
  if (!st.notify || st.muted.includes(msg.service.name)) return;
  if (st.otpOnly && !msg.otp && !(msg.links || []).length) return;
  const rec = store.getAddress(msg.to);
  const m = { ...msg, addrId: rec?.id };
  await safeLiveUpdate(msg.owner, mailCard(m, rec, st.style), mailKeyboard(m, { style: st.style }), msg.to);
}

/** Entry point for every inbound mail (Titan IMAP, Cloudflare Worker, Gmail). */
export async function ingest({ to, from, subject = '', text = '', html = '', messageId, date, source = 'imap', owner, silentNotify = false }) {
  to = String(to || '').toLowerCase();
  const key = messageId ? `${source}:${messageId}` : null;
  if (key && store.hasSeen(key)) return null;

  let rec = store.getAddress(to);
  if (rec?.expired) { store.markSeen(key); console.log(`⏳ dropped mail for expired address ${to}`); return null; }
  const ownerId = owner || rec?.owner || config.adminId;
  if (!ownerId) { console.warn('⚠️ No owner for', to, '- set TELEGRAM_CHAT_ID'); return null; }
  if (!rec && to.includes('@') && config.domains.some((d) => to.endsWith(`@${d}`))) {
    rec = store.ensureAddress(ownerId, to);
  }

  const a = analyze({ from, subject, text, html });
  const msg = store.addMessage({
    owner: ownerId, to, from, subject,
    text: a.plain.slice(0, 20000), html: String(html || '').slice(0, 80000),
    otp: a.otp, links: a.links, service: a.service, purpose: a.purpose, details: a.details,
    date: Number(date) || Date.now(), source, key,
  });
  const topLink = mainLink(msg);
  emitUserEvent(ownerId, 'mail:new', {
    message: {
      id: msg.id, to: msg.to, from: msg.from, subject: msg.subject, service: msg.service,
      purpose: msg.purpose, otp: msg.otp, date: msg.date, read: msg.read, pinned: msg.pinned,
      source: msg.source, links: (msg.links || []).length,
      firstLink: topLink ? { url: topLink.url, label: topLink.label || topLink.host } : null,
    },
    unread: store.countUnread(ownerId),
    stats: store.countStats(ownerId),
    silent: Boolean(silentNotify),
  });
  console.log(`⚡ [${source}] ${to} → ${ownerId}: ${a.service.name} / ${a.purpose} / OTP=${a.otp || '-'}`);
  if (!silentNotify && botApi) {
    try { await notifyMessage(msg); } catch (e) { console.warn('⚠️ notify failed:', e?.message || e); }
  }
  return msg;
}
