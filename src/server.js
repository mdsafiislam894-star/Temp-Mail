import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { config, webappUrl, gmailEnabled, setGoogleCreds } from './config.js';
import * as store from './store.js';
import { validateInitData } from './auth.js';
import { ingest, safeSend } from './notify.js';
import { gmailAuthUrl, handleOAuthCallback, startGmailPoller, pollNow, clearGmailTokenCache } from './gmail.js';
import { titanStatus, titanAccounts, startSingleImap } from './titan.js';
import { escapeHtml as esc } from './lib/mailparse.js';
import { mainLink } from './ui.js';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'webapp');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
let botUsername = '';
const savedGc = store.getMeta('googleCreds');
if (savedGc) setGoogleCreds(savedGc.id, savedGc.secret);
export const setBotUsername = (u) => { botUsername = u; };

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const readBody = (req, limit = 1000000) =>
  new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });

const summary = (m) => ({
  id: m.id, to: m.to, from: m.from, subject: m.subject, service: m.service, purpose: m.purpose,
  otp: m.otp, date: m.date, read: m.read, source: m.source, links: (m.links || []).length,
  firstLink: mainLink(m) ? { url: mainLink(m).url, label: mainLink(m).label || mainLink(m).host } : null,
});
const cleanName = (s = '') => s.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

async function inbound(req, res) {
  const auth = req.headers.authorization || '';
  if (!config.inboundSecret || !safeEq(auth, `Bearer ${config.inboundSecret}`)) return json(res, 401, { error: 'unauthorized' });
  const b = await readBody(req, 6000000);
  if (!b.to) return json(res, 400, { error: 'missing to' });
  const msg = await ingest({ ...b, source: 'worker' });
  return json(res, 200, { ok: true, id: msg?.id || null });
}

async function connectGmailImap(uid, email, rawPass) {
  const { ImapFlow } = await import('imapflow');
  const cleanAppPass = rawPass.replace(/\s+/g, '');
  for (const pass of cleanAppPass !== rawPass ? [cleanAppPass, rawPass] : [rawPass]) {
    const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: email, pass }, logger: false });
    try {
      await client.connect();
      await client.logout().catch(() => {});
      store.upsertGmail({ email, owner: uid, imapPass: pass, status: 'active', connectedAt: Date.now() });
      startSingleImap({ user: email, pass, host: 'imap.gmail.com', owner: uid });
      await safeSend(uid, `✅ <b>Gmail যুক্ত হয়েছে</b>\n<code>${esc(email)}</code>\nএখন থেকে এই ইনবক্সের OTP ও লিংক সাথে সাথে এখানে আসবে।`, undefined).catch(() => {});
      return true;
    } catch {}
  }
  return false;
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[1] === 'inbound' && req.method === 'POST') return inbound(req, res);

  const tg = validateInitData(req.headers['x-init-data']);
  if (!tg) return json(res, 401, { error: 'unauthorized' });
  const admin = String(tg.id) === config.adminId;
  if (!store.getUser(tg.id) && (admin || config.openAccess)) store.touchUser(tg, 'approved');
  const user = store.getUser(tg.id);
  if (!user || user.status !== 'approved') return json(res, 403, { error: 'not_approved' });
  const uid = user.id;
  const [, res1, id] = parts;
  const m = req.method;

  if (res1 === 'bootstrap' && (m === 'GET' || m === 'POST')) {
const body = m === 'POST' ? await readBody(req).catch(() => ({})) : {};
if (admin && body.restoreGoogle) {
try {
const gc = typeof body.restoreGoogle === 'string' ? JSON.parse(body.restoreGoogle) : body.restoreGoogle;
if (gc?.id && gc?.secret && !store.getMeta('googleCreds')) {
setGoogleCreds(gc.id, gc.secret);
store.setMeta('googleCreds', { id: config.google.clientId, secret: config.google.clientSecret });
}
} catch {}
}
const restore = body.restoreAddrs || url.searchParams.get('restore') || '';
if (restore) {
for (const addr of String(restore).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 40)) {
if (config.domains.some((d) => addr.endsWith(`@${d}`))) store.ensureAddress(uid, addr);
}
}
const restoreTotp = body.restoreTotp || url.searchParams.get('restoreTotp') || '';
if (restoreTotp) {
try {
const arr = typeof restoreTotp === 'string' ? JSON.parse(restoreTotp) : restoreTotp;
if (Array.isArray(arr)) for (const it of arr) if (it && it.secret) store.addTotp(uid, it.name || '2FA Account', it.secret, it.id || '');
} catch {}
}
if (body.restoreGmails) {
try {
const arr = typeof body.restoreGmails === 'string' ? JSON.parse(body.restoreGmails) : body.restoreGmails;
if (Array.isArray(arr)) {
let addedOAuth = false;
for (const g of arr) {
if (!g || !g.email || store.allGmail().some((x) => x.email === g.email)) continue;
store.upsertGmail({ email: g.email, owner: uid, refreshToken: g.refreshToken || '', imapPass: g.imapPass || '', clientId: g.clientId || '', clientSecret: g.clientSecret || '', status: g.status || 'active', connectedAt: g.connectedAt || Date.now() });
if (g.imapPass) startSingleImap({ user: g.email, pass: g.imapPass, host: 'imap.gmail.com', owner: uid });
if (g.refreshToken) addedOAuth = true;
}
if (addedOAuth) startGmailPoller();
}
} catch {}
}
return json(res, 200, {
user: { id: uid, name: user.name, username: user.username, admin },
domains: config.domains, prefDomain: 0, gmailEnabled: true,
brand: config.brand, unread: store.countUnread(uid), bot: botUsername, tz: config.tz, settings: store.getSettings(uid),
totp: store.listTotp(uid),
gmailVault: store.listGmail(uid),
googleCreds: admin ? { id: config.google.clientId || '', secret: config.google.clientSecret || '' } : null,
});
  }

  if (res1 === 'totp') {
    if (m === 'GET') return json(res, 200, { items: store.listTotp(uid), serverTime: Date.now() });
    if (m === 'POST') {
      const b = await readBody(req);
      if (Array.isArray(b.bulk)) {
        for (const it of b.bulk) {
          if (it && it.secret) store.addTotp(uid, it.name || '2FA Account', it.secret, it.id || '');
        }
        return json(res, 200, { ok: true, items: store.listTotp(uid) });
      }
      const item = store.addTotp(uid, b.name, b.secret, b.id || '');
      if (!item) return json(res, 400, { error: 'সঠিক ১৬ বা ৩২ ডিজিটের 2FA Secret কোড দিন' });
      return json(res, 200, { item, items: store.listTotp(uid) });
    }
    if (m === 'PATCH') {
      const b = await readBody(req);
      const item = store.updateTotp(uid, b.id || id, { name: b.name, secret: b.secret });
      if (!item) {
        const created = store.addTotp(uid, b.name, b.secret, b.id || '');
        return json(res, 200, { item: created, items: store.listTotp(uid) });
      }
      return json(res, 200, { item, items: store.listTotp(uid) });
    }
    if (m === 'DELETE') {
      const targetId = id || url.searchParams.get('id') || '';
      store.removeTotp(uid, targetId);
      return json(res, 200, { ok: true, items: store.listTotp(uid) });
    }
  }

  if (res1 === 'testmail' && m === 'POST') {
    const addrs = store.listAddresses(uid);
    const rec = addrs[0] || store.generateUniqueAddress(uid);
    const code = String(crypto.randomInt(100000, 999999));
    const msg = await ingest({
      to: rec.addr,
      owner: uid,
      from: 'Telegram <noreply@telegram.org>',
      subject: `Login Verification Code: ${code}`,
      text: `Your Telegram verification code is ${code}.\n\nOr tap here to verify your login: https://telegram.org/verify?code=${code}`,
      html: `<p>Your Telegram verification code is <b>${code}</b>.</p><p><a href="https://telegram.org/verify?code=${code}">Verify Login Now</a></p>`,
      messageId: `test:${Date.now()}:${code}`,
      date: Date.now(),
      source: 'imap',
    });
    return json(res, 200, { ok: true, code, to: rec.addr, id: msg?.id });
  }

  if (res1 === 'activity' && m === 'GET') {
    return json(res, 200, { hours: store.activity(admin && url.searchParams.get('scope') === 'all' ? null : uid, 24) });
  }

  if (res1 === 'settings') {
    if (m === 'POST') return json(res, 200, { settings: store.setSettings(uid, await readBody(req)) });
    return json(res, 200, { settings: store.getSettings(uid) });
  }

  if (res1 === 'messages') {
    if (id === 'readall' && m === 'POST') return json(res, 200, { ok: true, n: store.markAllRead(uid) });
    if (!id && m === 'DELETE') return json(res, 200, { ok: true, n: store.clearMessages(uid) });
    if (!id && m === 'GET') {
      const list = store.listMessages(uid, { limit: Math.min(100, Number(url.searchParams.get('limit')) || 50), q: url.searchParams.get('q') || '' });
      return json(res, 200, { messages: list.map(summary), unread: store.countUnread(uid), now: Date.now() });
    }
    const msg = store.getMessage(id);
    if (!msg || (msg.owner !== uid && !admin)) return json(res, 404, { error: 'not_found' });
    if (m === 'GET') { store.markRead(id); return json(res, 200, { ...summary(msg), text: msg.text, html: msg.html, linkList: msg.links }); }
    if (m === 'POST') { store.markRead(id); return json(res, 200, { ok: true }); }
    if (m === 'DELETE') { store.deleteMessage(id); return json(res, 200, { ok: true }); }
  }

  if (res1 === 'addresses') {
    if (m === 'GET') {
      const counts = {};
      for (const x of store.listMessages(uid, { limit: 500 })) counts[x.to] = (counts[x.to] || 0) + 1;
      return json(res, 200, { addresses: store.listAddresses(uid).map((a) => ({ id: a.id, addr: a.addr, label: a.label, createdAt: a.createdAt, count: counts[a.addr] || 0, ttl: a.ttl || 0, expiresAt: a.expiresAt || 0, expired: Boolean(a.expired) })) });
    }
    if (m === 'POST') {
      const b = await readBody(req);
      const name = cleanName(b.name || '');
      if (b.name && name.length < 3) return json(res, 400, { error: 'নাম কমপক্ষে ৩ অক্ষর (a-z, 0-9, . _ -)' });
      const ttlMin = b.ttl !== undefined ? Number(b.ttl) || 0 : (store.getSettings(uid).ttl || 0);
      const rec = store.generateUniqueAddress(uid, name, b.label || '', ttlMin);
      if (!rec) return json(res, 409, { error: 'এই নামটি আগে থেকেই ব্যবহৃত' });
      return json(res, 200, { address: { id: rec.id, addr: rec.addr, label: rec.label, count: 0, ttl: rec.ttl, expiresAt: rec.expiresAt, expired: rec.expired } });
    }
    if (m === 'PATCH') {
      const b = await readBody(req);
      const a = store.getAddressById(b.id);
      if (!a || a.owner !== uid) return json(res, 404, { error: 'not_found' });
      if (typeof b.label === 'string') store.setLabel(a.id, b.label);
      if (b.active) store.setPrimaryAddress(uid, a.id);
      if (b.extend) store.extendAddress(a.id, Number(b.extend) || 60);
      return json(res, 200, { ok: true });
    }
    if (m === 'DELETE') {
      const a = store.getAddressById(id);
      if (!a || a.owner !== uid) return json(res, 404, { error: 'not_found' });
      store.deleteAddress(id);
      return json(res, 200, { ok: true });
    }
  }

  if (res1 === 'gmail') {
if (id === 'sync' && m === 'POST') { await pollNow(); return json(res, 200, { ok: true, accounts: store.listGmail(uid) }); }
if (m === 'GET') {
return json(res, 200, {
enabled: true, oauthReady: gmailEnabled(),
accounts: store.listGmail(uid).map((g) => ({ email: g.email, status: g.status, lastError: g.lastError || '', connectedAt: g.connectedAt, refreshToken: g.refreshToken || '', imapPass: g.imapPass || '', clientId: g.clientId || '', clientSecret: g.clientSecret || '' })),
});
}
if (m === 'POST') {
const b = await readBody(req).catch(() => ({}));
const email = String(b.email || '').trim().toLowerCase();
const rawPass = String(b.password || '').trim();
const mode = b.mode || 'oauth';
const tryImap = async () => {
const { ImapFlow } = await import('imapflow');
const clean = rawPass.replace(/[\s\-]+/g, '');
for (const pass of clean !== rawPass ? [clean, rawPass] : [rawPass]) {
const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: email, pass }, logger: false });
try {
await client.connect(); await client.logout().catch(() => {});
store.upsertGmail({ email, owner: uid, imapPass: pass, status: 'active', lastError: '', connectedAt: Date.now() });
startSingleImap({ user: email, pass, host: 'imap.gmail.com', owner: uid });
await safeSend(uid, `✅ <b>Gmail যুক্ত হয়েছে</b>\n<code>${esc(email)}</code>\nএখন থেকে এই ইনবক্সের OTP ও লিংক এখানে আসবে।`, undefined).catch(() => {});
return true;
} catch {}
}
return false;
};
if (mode === 'app_pass') {
if (!email || !email.includes('@')) return json(res, 400, { error: 'সঠিক Gmail ঠিকানা লিখুন' });
if (!rawPass) return json(res, 400, { error: '১৬-অক্ষরের App Password লিখুন' });
if (await tryImap()) return json(res, 200, { connected: true, email, vault: store.listGmail(uid) });
return json(res, 400, { error: 'পাসওয়ার্ড বা App Password সঠিক নয়! সঠিক ১৬-অক্ষরের Google App Password দিন।' });
}
if (mode === 'browser_login' || (email && rawPass)) {
if (!email || !email.includes('@')) return json(res, 400, { error: 'সঠিক Gmail ঠিকানা লিখুন' });
if (!rawPass || rawPass.length < 4) return json(res, 400, { error: 'সঠিক পাসওয়ার্ড লিখুন' });
if (await tryImap()) return json(res, 200, { connected: true, email, vault: store.listGmail(uid) });
if (gmailEnabled()) return json(res, 200, { browserLogin: true, email, url: gmailAuthUrl(uid, email, true) });
return json(res, 400, { error: 'সরাসরি পাসওয়ার্ড লগইনের জন্য Google OAuth অথবা ১৬-অক্ষরের App Password প্রয়োজন।' });
}
if (gmailEnabled()) return json(res, 200, { url: gmailAuthUrl(uid, email, Boolean(b.forceLogin)) });
return json(res, 400, { error: 'Admin Tools থেকে Google Client ID ও Secret সেট করুন।' });
}
if (m === 'DELETE') { store.removeGmail(uid, url.searchParams.get('email') || ''); return json(res, 200, { ok: true, accounts: store.listGmail(uid) }); }
  }

    if (res1 === 'admin') {
    if (!admin) return json(res, 403, { error: 'admin only' });
    if (id === 'stats' && m === 'GET') {
      const mem = process.memoryUsage();
      return json(res, 200, {
        stats: store.stats(),
        titan: { ...titanStatus(), accounts: titanAccounts() },
        users: store.usersDetailed().sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 100),
        messages: store.listMessages(null, { limit: 100 }).map((x) => ({ ...summary(x), ownerName: store.getUser(x.owner)?.name || x.owner, ownerId: x.owner })),
        activity: store.activity(null, 24),
        system: { uptime: Math.floor(process.uptime()), rss: Math.round(mem.rss / 1048576), node: process.version },
        openAccess: config.openAccess, domains: config.domains, gmailEnabled: gmailEnabled(),
        googleClientId: config.google.clientId || '', googleClientSecret: config.google.clientSecret || '', callbackUrl: `${config.publicUrl}/auth/google/callback`,
        totp: store.listTotp(uid),
      });
    }
    if (m === 'POST') {
      const b = await readBody(req);
      if (id === 'google') {
          const cid = String(b.clientId || '').trim() || config.google.clientId;
          const csec = String(b.clientSecret || '').trim() || config.google.clientSecret;
          setGoogleCreds(cid, csec);
          store.setMeta('googleCreds', { id: config.google.clientId, secret: config.google.clientSecret });
          clearGmailTokenCache();
          startGmailPoller();
          pollNow().catch(() => {});
          return json(res, 200, { ok: true, gmailEnabled: gmailEnabled(), googleClientId: config.google.clientId, googleClientSecret: config.google.clientSecret });
        }
      if (id === 'user') {
        if (b.action === 'delete' && String(b.id) !== config.adminId) { store.deleteUser(b.id); return json(res, 200, { ok: true }); }
        if (b.action === 'clear_mails') { store.clearMessages(b.id); return json(res, 200, { ok: true }); }
        if (b.action === 'message') {
          const text = String(b.text || '').trim().slice(0, 1500);
          if (!text || !store.getUser(b.id)) return json(res, 400, { error: 'bad request' });
          await safeSend(b.id, `📩 <b>Admin message</b>\n━━━━━━━━━━━━━━\n${esc(text)}`, undefined);
          return json(res, 200, { ok: true });
        }
        const status = { approve: 'approved', reject: 'banned', ban: 'banned', unban: 'approved' }[b.action];
        const u = status && store.getUser(b.id) && String(b.id) !== config.adminId ? store.setUserStatus(b.id, status) : null;
        if (!u) return json(res, 400, { error: 'bad request' });
        if (b.action === 'approve' || b.action === 'unban') await safeSend(u.id, '✅ <b>Your access request was accepted.</b>\n\n⚡ শুরু করতে /start চাপুন।', undefined);
        return json(res, 200, { ok: true });
      }
      if (id === 'broadcast') {
        const text = String(b.text || '').trim().slice(0, 3000);
        if (!text) return json(res, 400, { error: 'empty' });
        const targets = store.listUsers().filter((u) => u.status === 'approved');
        (async () => { for (const u of targets) { await safeSend(u.id, `📢 <b>Announcement</b>\n━━━━━━━━━━━━━━\n${esc(text)}`, undefined); await new Promise((r) => setTimeout(r, 40)); } })();
        return json(res, 200, { ok: true, count: targets.length });
      }
      if (id === 'access') {
        config.openAccess = Boolean(b.open);
        store.setMeta('openAccess', config.openAccess);
        return json(res, 200, { ok: true, openAccess: config.openAccess });
      }
      if (id === 'sweep') return json(res, 200, { ok: true, expired: 0 });
    }
  }
  return json(res, 404, { error: 'not_found' });
}

const page = (ok, title, text) => `<!doctype html><html lang="bn"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d17;color:#fff;font:16px system-ui,sans-serif}
.c{max-width:360px;padding:32px;text-align:center;border-radius:24px;background:linear-gradient(160deg,#1a1f3a,#10132a);border:1px solid #ffffff18}
.i{font-size:56px}a{display:inline-block;margin-top:20px;padding:14px 28px;border-radius:14px;background:${ok ? 'linear-gradient(135deg,#22c55e,#16a34a)' : 'linear-gradient(135deg,#ef4444,#dc2626)'};color:#fff;text-decoration:none;font-weight:700}p{opacity:.8}</style>
<div class="c"><div class="i">${ok ? '✅' : '⚠️'}</div><h2>${esc(title)}</h2><p>${esc(text)}</p><a id="backBtn" href="${botUsername ? `https://t.me/${botUsername}` : 'tg://'}">🚀 Telegram অ্যাপে ফিরে যান</a></div><script>if(${ok ? 'true' : 'false'}){setTimeout(()=>{location.href=${JSON.stringify(botUsername ? `tg://resolve?domain=${botUsername}` : 'tg://')}},900)}</script>`;

export function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (url.pathname === '/auth/google/callback') {
        const r = await handleOAuthCallback(url.searchParams.get('code'), url.searchParams.get('state'), url.searchParams.get('error'));
        res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Clear-Site-Data': '"cookies", "storage"' });
        return res.end(page(r.ok, r.ok ? 'Gmail যুক্ত হয়েছে' : 'সমস্যা হয়েছে', r.ok ? r.email : r.message));
      }
      if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
        const rel = url.pathname === '/app' || url.pathname === '/app/' ? 'index.html' : url.pathname.slice(5);
        const file = path.normalize(path.join(WEB, rel));
        if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        return fs.createReadStream(file).pipe(res);
      }
      return json(res, 200, { status: 'online', service: `${config.brand} 24/7`, app: Boolean(webappUrl()), time: new Date().toISOString() });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: 'server_error' });
    }
  });
  server.listen(config.port, () => console.log(`🌐 HTTP server :${config.port}`));
  return server;
}
