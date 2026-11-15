import 'dotenv/config';
import { config } from './src/config.js';
import * as store from './src/store.js';
import { createBot, startBot } from './src/bot.js';
import { startServer, setBotUsername } from './src/server.js';
import { startTitan, stopTitan } from './src/titan.js';
import { startGmailPoller, stopGmailPoller } from './src/gmail.js';
import { closeAllEvents, emitUserEvent } from './src/events.js';

process.on('uncaughtException', (e) => console.error('⚠️ uncaughtException:', e?.message || e));
process.on('unhandledRejection', (e) => console.error('⚠️ unhandledRejection:', e?.message || e));

console.log(`🚀 ${config.brand} v4 starting...`);

if (!config.token) {
  console.error('❌ TELEGRAM_BOT_TOKEN পাওয়া যায়নি!');
  process.exit(1);
}
if (!config.adminId) console.warn('⚠️ TELEGRAM_CHAT_ID সেট নেই — কেউ অ্যাডমিন হতে পারবে না!');

const server = startServer();
const bot = createBot();
startTitan();
startGmailPoller();

startBot(bot).then((me) => {
  if (me?.username) setBotUsername(me.username);
}).catch((e) => console.error('⚠️ Bot init warning:', e?.message || e));

const sweepTimer = setInterval(() => {
  try {
    const expired = store.expireSweep();
    if (expired > 0) emitUserEvent(config.adminId, 'admin:sweep', { expired });
  } catch {}
}, 60000);
sweepTimer.unref?.();

const shutdown = async (sig) => {
  console.log(`\n${sig} — shutting down`);
  clearInterval(sweepTimer);
  stopTitan();
  stopGmailPoller();
  closeAllEvents();
  store.flush();
  try { await bot.stop(); } catch {}
  try { server.close(); } catch {}
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
