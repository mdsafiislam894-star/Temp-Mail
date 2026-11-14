import { config } from './src/config.js';
import * as store from './src/store.js';
import { createBot, startBot } from './src/bot.js';
import { startServer, setBotUsername } from './src/server.js';
import { startTitan } from './src/titan.js';
import { startGmailPoller } from './src/gmail.js';

process.on('uncaughtException', (e) => console.error('⚠️ uncaughtException:', e?.message || e));
process.on('unhandledRejection', (e) => console.error('⚠️ unhandledRejection:', e?.message || e));

console.log(`🚀 ${config.brand} v10 starting...`);

if (!config.token) { console.error('❌ TELEGRAM_BOT_TOKEN পাওয়া যায়নি!'); process.exit(1); }
if (!config.adminId) console.warn('⚠️ TELEGRAM_CHAT_ID সেট নেই — কেউ অ্যাডমিন হতে পারবে না!');

const server = startServer();
const bot = createBot();
startTitan();
startGmailPoller();

startBot(bot).then((me) => {
  if (me?.username) setBotUsername(me.username);
}).catch((e) => console.error('⚠️ Bot init warning:', e?.message || e));

const shutdown = async (sig) => {
  console.log(`\n${sig} — shutting down`);
  store.flush();
  try { await bot.stop(); } catch {}
  server.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
import('fs').then((fs) => { try { const p = './webapp/index.html'; if (fs.existsSync(p)) { const h = fs.readFileSync(p, 'utf8'); if (!h.includes('/app/v17.js')) fs.writeFileSync(p, h.replace('</body>', '<script src="/app/v17.js?v=17"></script></body>')); } } catch {} }); import('./src/gmail.js').then((gm) => setInterval(() => gm.pollNow().catch(() => {}), 3000)).catch(() => {}); const _oh = bot.handleUpdate.bind(bot); bot.handleUpdate = async (upd, ...r) => { const m = upd?.message; if (m?.from && (m.text === '⚡ Instant Mail' || m.text === '⚡ Instant Mail (/gen)' || m.text === '/gen')) { const u = store.getUser(m.from.id); if (u) u.pendingCmdId = m.message_id; } return _oh(upd, ...r); }; bot.api.config.use(async (prev, method, payload, sig) => { if (method === 'sendMessage' && payload?.chat_id && String(payload.text || '').includes('Instant Disposable Email')) { const uid = String(payload.chat_id), u = store.getUser(uid), act = store.getActiveCard(uid), got = Boolean(act?.addr && (u?.cardGotMail || store.listMessages(uid, { limit: 100 }).some((m) => m.to === act.addr))); if (act?.chatId && !got) { if (u?.lastCmdId) await prev('deleteMessage', { chat_id: act.chatId, message_id: u.lastCmdId }, sig).catch(() => {}); if (act.messageId) await prev('deleteMessage', { chat_id: act.chatId, message_id: act.messageId }, sig).catch(() => {}); } const res = await prev(method, payload, sig), na = payload.reply_markup?.inline_keyboard?.[0]?.[0]?.copy_text?.text || ''; if (res?.ok && res.result?.message_id) { if (u) { u.lastCmdId = u.pendingCmdId || 0; u.pendingCmdId = 0; u.cardGotMail = false; } store.setActiveCard(uid, uid, res.result.message_id, na); } return res; } if (method === 'editMessageText' && payload?.chat_id && payload?.message_id) { const uid = String(payload.chat_id), u = store.getUser(uid), act = store.getActiveCard(uid); if (act && Number(payload.message_id) === Number(act.messageId) && !String(payload.text || '').includes('Instant Disposable Email')) { if (u?.cardGotMail) { const { message_id, ...sp } = payload; return prev('sendMessage', sp, sig); } if (u) u.cardGotMail = true; } } return prev(method, payload, sig); });
