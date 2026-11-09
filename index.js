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
