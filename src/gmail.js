import { simpleParser } from 'mailparser';
import { config, gmailEnabled } from './config.js';
import * as store from './store.js';
import { signToken, verifyToken } from './auth.js';
import { ingest, safeSend } from './notify.js';

const SCOPE = 'openid email https://www.googleapis.com/auth/gmail.readonly';
const redirectUri = () => `${config.publicUrl}/auth/google/callback`;

/** URL that opens Google's account chooser (all accounts signed in on the phone's browser are listed). */
export function gmailAuthUrl(uid, loginHint = '', forceLogin = false) {
const params = { client_id: config.google.clientId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: forceLogin ? 'login consent' : 'select_account consent', include_granted_scopes: 'true', state: signToken({ uid: String(uid) }, 900) };
if (loginHint && loginHint.includes('@')) params.login_hint = loginHint.trim();
return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams(params)}`;
};

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error_description || data.error || `HTTP ${res.status}`); e.code = data.error; throw e; }
  return data;
}

const decodeJwt = (jwt = '') => JSON.parse(Buffer.from(jwt.split('.')[1] || 'e30', 'base64url').toString());

export async function handleOAuthCallback(code, state, error) {
  if (error) return { ok: false, message: error === 'access_denied' ? 'আপনি অনুমতি দেননি।' : error };
  const st = verifyToken(state);
  if (!st || !code) return { ok: false, message: 'লিংকের মেয়াদ শেষ বা অবৈধ। বট থেকে আবার চেষ্টা করুন।' };
  try {
    const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
    const email = String(decodeJwt(t.id_token).email || '').toLowerCase();
    if (!email) throw new Error('email পাওয়া যায়নি');
    const prev = store.allGmail().find((g) => g.email === email);
    const refreshToken = t.refresh_token || prev?.refreshToken;
    if (!refreshToken) throw new Error('refresh token পাওয়া যায়নি — Google Account → Security → Third-party access থেকে অ্যাপটি সরিয়ে আবার চেষ্টা করুন।');
    store.upsertGmail({ email, owner: st.uid, refreshToken, status: 'active', connectedAt: Date.now() });
    cache.set(email, { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 });
    await safeSend(st.uid, `✅ <b>Gmail যুক্ত হয়েছে</b>\n<code>${email}</code>\nএখন থেকে এই ইনবক্সের OTP ও লিংক এখানে আসবে।`, undefined);
    return { ok: true, email };
  } catch (e) {
    console.error('Google OAuth error:', e.message);
    return { ok: false, message: e.message };
  }
}

// ---------- polling ----------
const cache = new Map(); // email -> { token, exp }

async function accessToken(acc) {
  const c = cache.get(acc.email);
  if (c && c.exp > Date.now()) return c.token;
  const t = await tokenRequest({ refresh_token: acc.refreshToken, grant_type: 'refresh_token' });
  cache.set(acc.email, { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 });
  return t.access_token;
}

async function gget(acc, path, retry = true) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${await accessToken(acc)}` } });
  if (res.status === 401 && retry) { cache.delete(acc.email); return gget(acc, path, false); }
  if (!res.ok) throw new Error(`Gmail API ${res.status}`);
  return res.json();
}

async function pollAccount(acc) {
  if (!acc.refreshToken) return;
  const list = await gget(acc, `messages?q=${encodeURIComponent('in:inbox newer_than:1d')}&maxResults=20`);
  const ids = (list.messages || []).map((m) => m.id).reverse(); // oldest first
  for (const id of ids) {
    const key = `gmail:${acc.email}:${id}`;
    if (store.hasSeen(key)) continue;
    const full = await gget(acc, `messages/${id}?format=raw`);
    if (Number(full.internalDate) < acc.connectedAt - 120000) { store.markSeen(key); continue; } // older than connect time
    const p = await simpleParser(Buffer.from(full.raw, 'base64url'));
    await ingest({
      to: acc.email, owner: acc.owner, source: 'gmail', messageId: `${acc.email}:${id}`,
      from: p.from?.text || 'Unknown', subject: p.subject || '', text: p.text || '',
      html: typeof p.html === 'string' ? p.html : '', date: Number(full.internalDate),
    });
  }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    for (const acc of store.allGmail().filter((g) => g.status !== 'expired')) {
      try { await pollAccount(acc); } catch (e) {
        if (e.code === 'invalid_grant') {
          store.upsertGmail({ email: acc.email, status: 'expired' });
          await safeSend(acc.owner, `⚠️ <b>${acc.email}</b> এর অ্যাক্সেস শেষ হয়ে গেছে।\n/gmail থেকে আবার যুক্ত করুন।`, undefined);
        } else console.error(`Gmail poll ${acc.email}:`, e.message);
      }
    }
  } finally { running = false; }
}

let pollerOn = false;
export function startGmailPoller() {
  if (!gmailEnabled() || pollerOn) return;
  pollerOn = true;
  if (false) { console.log('ℹ️ Gmail বন্ধ (GOOGLE_CLIENT_ID/SECRET বা https PUBLIC_URL নেই)।'); return; }
  setInterval(tick, config.google.pollMs);
  console.log(`📧 Gmail poller চালু (প্রতি ${config.google.pollMs / 1000}s)`);
}

export async function pollNow() { try { await tick(); } catch {} }
