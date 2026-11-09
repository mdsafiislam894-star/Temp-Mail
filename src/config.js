import path from 'path';


const env = process.env;
const list = (v = '') => v.split(',').map((s) => s.trim()).filter(Boolean);

function titanAccounts() {
  const raw = env.TITAN_ACCOUNTS || '';
  if (!raw) {
    return env.TITAN_EMAIL && env.TITAN_PASSWORD ? [{ user: env.TITAN_EMAIL, pass: env.TITAN_PASSWORD }] : [];
  }
  // format: mail1@dom.com:pass1,mail2@dom.com:pass2   (password may contain ':')
  return raw.split(',').map((item) => {
    const i = item.indexOf(':');
    return { user: item.slice(0, i).trim(), pass: item.slice(i + 1).trim() };
  }).filter((a) => a.user && a.pass);
}

export const config = {
  token: env.TELEGRAM_BOT_TOKEN,
  adminId: String(env.TELEGRAM_CHAT_ID || '').trim(),
  domains: list(env.YOUR_DOMAINS || 'mdsafiislam.tech, mdsafix.tech').map((d) => d.toLowerCase()),
  brand: env.BRAND_NAME || 'ARIYAN MAIL',
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || 'https://temp-mail-pks1.onrender.com').replace(/\/+$/, ''),
  port: Number(env.PORT) || 3000,
  dataDir: path.resolve(env.DATA_DIR || './data'),
  tz: env.TZ_NAME || 'Asia/Dhaka',
  openAccess: env.OPEN_ACCESS ? env.OPEN_ACCESS === 'true' : true,
  inboundSecret: env.INBOUND_SECRET || '',
  retentionDays: Number(env.RETENTION_DAYS) || 7,
  maxPerUser: Number(env.MAX_MESSAGES_PER_USER) || 150,
  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    pollMs: Math.max(3000, Number(env.GMAIL_POLL_MS) || 6000),
  },
  titan: { accounts: titanAccounts(), host: env.TITAN_IMAP_HOST || 'imap.titan.email' },
};

export const webappUrl = () => (config.publicUrl.startsWith('https://') ? `${config.publicUrl}/app` : '');
export const gmailEnabled = () =>
  Boolean(config.google.clientId && config.google.clientSecret && config.publicUrl.startsWith('https://'));

export function setGoogleCreds(id, secret) {
if (id !== undefined) config.google.clientId = String(id || '').trim();
if (secret !== undefined) config.google.clientSecret = String(secret || '').trim();
}
