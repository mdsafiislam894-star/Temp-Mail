import path from 'path';
const env = process.env;
function titanAccounts() {
const raw = env.TITAN_ACCOUNTS || '';
if (!raw) return env.TITAN_EMAIL && env.TITAN_PASSWORD ? [{ user: env.TITAN_EMAIL, pass: env.TITAN_PASSWORD }] : [];
return raw.split(',').map((item) => {
const i = item.indexOf(':');
return i > 0 ? { user: item.slice(0, i).trim(), pass: item.slice(i + 1).trim() } : null;
}).filter(Boolean);
}
export const envGoogle = {
clientId: (env.GOOGLE_CLIENT_ID || '').trim(),
clientSecret: (env.GOOGLE_CLIENT_SECRET || '').trim(),
};
export const config = {
token: env.TELEGRAM_BOT_TOKEN,
adminId: String(env.TELEGRAM_CHAT_ID || '').trim(),
domains: ['safix.tech'],
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
clientId: envGoogle.clientId,
clientSecret: envGoogle.clientSecret,
pollMs: Math.max(2500, Number(env.GMAIL_POLL_MS) || 3500),
},
titan: { accounts: titanAccounts(), host: env.TITAN_IMAP_HOST || 'imap.titan.email' },
};
export function setGoogleCreds(id, secret) {
if (id !== undefined && String(id).trim()) config.google.clientId = String(id).trim();
if (secret !== undefined && String(secret).trim()) config.google.clientSecret = String(secret).trim();
}
export const webappUrl = () => (config.publicUrl.startsWith('https://') ? `${config.publicUrl}/app?v=15` : '');
export const gmailEnabled = () => Boolean(config.google.clientId && config.google.clientSecret && config.publicUrl.startsWith('https://'));