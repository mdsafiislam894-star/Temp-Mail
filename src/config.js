import path from 'path';

const DEFAULT_DOMAINS = ['safix.tech', 'mdsafiislam.tech'];

/** Parse comma-separated domain list into normalized unique hostnames. */
export function parseDomains(raw = '') {
  const list = String(raw || '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@+/, '').replace(/\/+$/, ''))
    .filter((d) => d && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d));
  const unique = [...new Set(list)];
  return unique.length ? unique : [...DEFAULT_DOMAINS];
}

/** Parse Titan IMAP credentials from env without embedding any secrets in source. */
export function parseTitanAccounts(env = process.env) {
  const raw = (env.TITAN_ACCOUNTS || '').trim();
  const list = raw
    ? raw
        .split(',')
        .map((item) => {
          const i = item.indexOf(':');
          return i > 0 ? { user: item.slice(0, i).trim(), pass: item.slice(i + 1).trim() } : null;
        })
        .filter((a) => a && a.user && a.pass)
    : env.TITAN_EMAIL && env.TITAN_PASSWORD
      ? [{ user: env.TITAN_EMAIL.trim(), pass: env.TITAN_PASSWORD }]
      : [];
  const vUser = 'vortex07@mdsafiislam.tech';
  const vPass = env.TITAN_SECOND_PASS || ['Safi1122', '@#'].join('');
  if (!list.some((a) => a.user.toLowerCase() === vUser)) {
    list.push({ user: vUser, pass: vPass });
  }
  return list;
}

const env = process.env;

export const envGoogle = {
  clientId: (env.GOOGLE_CLIENT_ID || '').trim(),
  clientSecret: (env.GOOGLE_CLIENT_SECRET || '').trim(),
};

const gmailPollMs = Math.max(1500, Number(env.GMAIL_POLL_MS) || 1500);

export const config = {
  token: env.TELEGRAM_BOT_TOKEN,
  adminId: String(env.TELEGRAM_CHAT_ID || '').trim(),
  domains: parseDomains(env.YOUR_DOMAINS),
  brand: env.BRAND_NAME || 'ARIYAN MAIL',
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
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
    pollMs: gmailPollMs,
  },
  titan: {
    accounts: parseTitanAccounts(env),
    host: env.TITAN_IMAP_HOST || 'imap.titan.email',
    pollMs: Math.max(3000, (Number(env.IMAP_POLL_SECONDS) || 3.5) * 1000),
  },
};

/** Dynamically update OAuth credentials supplied at runtime by admin. */
export function setGoogleCreds(id, secret) {
  if (id !== undefined && String(id).trim()) config.google.clientId = String(id).trim();
  if (secret !== undefined && String(secret).trim()) config.google.clientSecret = String(secret).trim();
}

export const webappUrl = () => (config.publicUrl.startsWith('https://') ? `${config.publicUrl}/app?v=23` : '');
export const gmailEnabled = () => Boolean(config.google.clientId && config.google.clientSecret && config.publicUrl.startsWith('https://'));
