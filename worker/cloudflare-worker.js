/**
 * Cloudflare Email Routing Worker  →  forwards every mail to the bot (/api/inbound).
 * - Uses postal-mime, so base64 / quoted-printable / charset-encoded mails are decoded properly
 *   (the old version regex-scanned the RAW mime source, which broke OTPs and links).
 * - If the bot server is down, falls back to sending a basic message straight to Telegram,
 *   so an OTP is never lost.
 */
import PostalMime from 'postal-mime';
import { analyze, escapeHtml } from '../src/lib/mailparse.js';

async function direct(env, payload) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const a = analyze(payload);
  let text = `📬 <b>New Mail</b> (fallback)\n━━━━━━━━━━━━━━\n👤 <code>${escapeHtml(payload.to)}</code>\n` +
    `${a.service.icon} <b>${escapeHtml(a.service.name)}</b> › ${escapeHtml(a.purpose)}\n`;
  if (a.otp) text += `🔐 <b>Code:</b> <code>${escapeHtml(a.otp)}</code>`;
  const kb = [];
  if (a.otp) kb.push([{ text: `🔐 ${a.otp} • Tap to copy`, copy_text: { text: a.otp }, style: 'success' }]);
  if (a.links[0]) kb.push([{ text: `🔗 ${a.links[0].label} ↗`, url: a.links[0].url, style: 'primary' }]);
  const send = (body) => fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const base = { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  const r = await send({ ...base, reply_markup: { inline_keyboard: kb } });
  if (!r.ok) await send({ ...base, reply_markup: { inline_keyboard: kb.map((row) => row.filter((b) => !b.url)).filter((row) => row.length) } });
}

export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const p = await PostalMime.parse(raw);
    const payload = {
      to: message.to,
      from: p.from ? `${p.from.name || ''} <${p.from.address || message.from}>`.trim() : message.from,
      subject: p.subject || '',
      text: p.text || '',
      html: p.html || '',
      messageId: p.messageId || message.headers.get('message-id') || '',
      date: p.date ? Date.parse(p.date) || Date.now() : Date.now(),
    };

    if (env.BOT_URL && env.INBOUND_SECRET) {
      try {
        const r = await fetch(`${env.BOT_URL.replace(/\/+$/, '')}/api/inbound`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.INBOUND_SECRET}` },
          body: JSON.stringify(payload),
        });
        if (r.ok) return;
        console.log('bot responded', r.status);
      } catch (e) { console.log('bot unreachable', e.message); }
    }
    await direct(env, payload);
  },
};
