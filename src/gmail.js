import { simpleParser } from 'mailparser';
import { ImapFlow } from 'imapflow';
import { config, envGoogle } from './config.js';
import * as store from './store.js';
import { signToken, verifyToken } from './auth.js';
import { ingest, safeSend } from './notify.js';
import { btn, rows } from './ui.js';
const SCOPE = 'openid email https://www.googleapis.com/auth/gmail.readonly';
const redirectUri = () => `${config.publicUrl}/auth/google/callback`;
const initialPolled = new Set(), apiAlertSent = new Set(), xoauthListeners = new Set();
const cache = new Map();
export const clearGmailTokenCache = () => cache.clear();
export function gmailAuthUrl(uid, loginHint = '', forceLogin = false) {
const params = {
client_id: config.google.clientId,
redirect_uri: redirectUri(),
response_type: 'code',
scope: SCOPE,
access_type: 'offline',
prompt: loginHint && loginHint.includes('@') ? 'consent' : 'select_account consent',
include_granted_scopes: 'true',
state: signToken({ uid: String(uid), cid: config.google.clientId, oneTime: Boolean(forceLogin) }, 1800),
};
if (loginHint && loginHint.includes('@')) params.login_hint = loginHint.trim();
return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams(params)}`;
}
function getCredPairs(acc = null) {
const pairs = [];
const add = (id, sec) => { if (id && sec && !pairs.some((p) => p.id === id && p.sec === sec)) pairs.push({ id, sec }); };
if (acc?.clientId && acc?.clientSecret) add(acc.clientId, acc.clientSecret);
add(config.google.clientId, config.google.clientSecret);
const saved = store.getMeta('googleCreds');
if (saved?.id && saved?.secret) add(saved.id, saved.secret);
add(envGoogle.clientId, envGoogle.clientSecret);
return pairs;
}
async function tokenRequest(params, acc = null) {
const pairs = getCredPairs(acc);
let lastErr = new Error('Google OAuth Client ID/Secret সেট করা নেই');
for (const p of pairs) {
const res = await fetch('https://oauth2.googleapis.com/token', {
method: 'POST',
headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
body: new URLSearchParams({ client_id: p.id, client_secret: p.sec, ...params }),
});
const data = await res.json().catch(() => ({}));
if (res.ok && data.access_token) return { ...data, usedClientId: p.id, usedClientSecret: p.sec };
const e = new Error(data.error_description || data.error || `HTTP ${res.status}`);
e.code = data.error; lastErr = e;
}
throw lastErr;
}
const decodeJwt = (jwt = '') => {
try { return JSON.parse(Buffer.from(jwt.split('.')[1] || 'e30', 'base64url').toString()); } catch { return {}; }
};
export async function handleOAuthCallback(code, state, error) {
if (error) return { ok: false, message: error === 'access_denied' ? 'আপনি অনুমতি দেননি।' : error };
const st = verifyToken(state);
if (!st || !code) return { ok: false, message: 'লিংকের মেয়াদ শেষ বা অবৈধ। আবার চেষ্টা করুন।' };
try {
const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
let email = String(decodeJwt(t.id_token).email || '').toLowerCase();
if (!email && t.access_token) {
const uRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${t.access_token}` } }).catch(() => null);
if (uRes && uRes.ok) email = String((await uRes.json().catch(() => ({}))).email || '').toLowerCase();
}
if (!email) throw new Error('Google থেকে ইমেইল ঠিকানা পাওয়া যায়নি');
const prev = store.allGmail().find((g) => g.email === email);
const refreshToken = t.refresh_token || prev?.refreshToken;
if (!refreshToken) throw new Error('refresh token পাওয়া যায়নি — আবার Continue with Gmail চাপুন।');
const rec = store.upsertGmail({
email, owner: st.uid, refreshToken,
clientId: t.usedClientId || config.google.clientId,
clientSecret: t.usedClientSecret || config.google.clientSecret,
status: 'active', lastError: '', connectedAt: Date.now(),
});
cache.set(email, { token: t.access_token, exp: Date.now() + (Number(t.expires_in || 3500) - 60) * 1000 });
startGmailPoller();
pollAccount(rec).catch(() => {});
await safeSend(st.uid, `✅ <b>Gmail সফলভাবে যুক্ত হয়েছে!</b>\n📧 <code>${email}</code>\nএখন থেকে এই ইনবক্সের সব OTP ও ভেরিফিকেশন লিংক সাথে সাথে এখানে আসবে।`, undefined);
return { ok: true, email, oneTime: st.oneTime !== false };
} catch (e) {
return { ok: false, message: e.message };
}
}
async function accessToken(acc) {
const c = cache.get(acc.email);
if (c && c.exp > Date.now()) return c.token;
const t = await tokenRequest({ refresh_token: acc.refreshToken, grant_type: 'refresh_token' }, acc);
if (t.usedClientId && (acc.clientId !== t.usedClientId || acc.clientSecret !== t.usedClientSecret)) {
store.upsertGmail({ email: acc.email, clientId: t.usedClientId, clientSecret: t.usedClientSecret, status: 'active' });
}
cache.set(acc.email, { token: t.access_token, exp: Date.now() + (Number(t.expires_in || 3500) - 60) * 1000 });
return t.access_token;
}
async function gget(acc, path, retry = true) {
const tok = await accessToken(acc);
const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${tok}` } });
if (res.status === 401 && retry) { cache.delete(acc.email); return gget(acc, path, false); }
if (!res.ok) {
const errBody = await res.json().catch(() => ({}));
const e = new Error(errBody?.error?.message || `Gmail API ${res.status}`);
e.status = res.status; throw e;
}
return res.json();
}
async function pollViaXoauthImap(acc) {
const tok = await accessToken(acc);
const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: acc.email, accessToken: tok }, logger: false });
try {
await client.connect();
const lock = await client.getMailboxLock('INBOX');
try {
const uids = (await client.search({ since: new Date(Date.now() - 2 * 86400000) }, { uid: true }).catch(() => [])) || [];
const isFirst = !initialPolled.has(acc.email);
for (const uid of uids.filter((u) => !store.hasSeen(`gmuid:${acc.email}:${uid}`)).slice(-15)) {
const msg = await client.fetchOne(uid, { source: true }, { uid: true }).catch(() => null);
if (msg?.source) {
const p = await simpleParser(msg.source);
const msgDate = p.date ? p.date.getTime() : Date.now();
await ingest({
to: acc.email, owner: acc.owner, source: 'gmail', messageId: `${acc.email}:imap:${uid}`,
from: p.from?.text || 'Unknown', subject: p.subject || '', text: p.text || '',
html: typeof p.html === 'string' ? p.html : '', date: msgDate, silentNotify: isFirst && (Date.now() - msgDate > 600000),
});
store.markSeen(`gmuid:${acc.email}:${uid}`);
}
}
initialPolled.add(acc.email);
if (acc.lastError) store.upsertGmail({ email: acc.email, status: 'active', lastError: '' });
} finally { lock.release(); }
await client.logout().catch(() => {});
return true;
} catch { try { client.close(); } catch {} return false; }
}
async function pollAccount(acc) {
if (!acc.refreshToken) return;
const isFirst = !initialPolled.has(acc.email);
try {
const list = await gget(acc, `messages?q=${encodeURIComponent('newer_than:2d -from:me')}&maxResults=15`);
for (const id of (list.messages || []).map((m) => m.id).reverse()) {
const key = `gmail:${acc.email}:${id}`;
if (store.hasSeen(key)) continue;
const full = await gget(acc, `messages/${id}?format=raw`);
const msgDate = Number(full.internalDate) || Date.now();
const p = await simpleParser(Buffer.from(full.raw, 'base64url'));
await ingest({
to: acc.email, owner: acc.owner, source: 'gmail', messageId: `${acc.email}:${id}`,
from: p.from?.text || 'Unknown', subject: p.subject || '', text: p.text || '',
html: typeof p.html === 'string' ? p.html : '', date: msgDate, silentNotify: isFirst && (Date.now() - msgDate > 600000),
});
}
initialPolled.add(acc.email);
if (acc.lastError || acc.status !== 'active') store.upsertGmail({ email: acc.email, status: 'active', lastError: '' });
} catch (e) {
if (await pollViaXoauthImap(acc)) return;
if (e.status === 403 && /gmail\.googleapis\.com|has not been used|disabled/i.test(e.message || '')) {
const urlMatch = (e.message || '').match(/https:\/\/console\.developers\.google\.com[^\s"']+/);
const enableUrl = urlMatch ? urlMatch[0] : 'https://console.cloud.google.com/apis/library/gmail.googleapis.com';
store.upsertGmail({ email: acc.email, lastError: 'Google Cloud প্রজেক্টে Gmail API Enable করা নেই' });
const alertKey = `${acc.owner}:${config.google.clientId}`;
if (!apiAlertSent.has(alertKey)) {
apiAlertSent.add(alertKey);
await safeSend(acc.owner, `⚠️ <b>Gmail API चालू করুন (১ ক্লিকে)</b>\nআপনার নতুন Google Cloud প্রজেক্টে <b>Gmail API</b> এখনো Enable করা হয়নি। নিচের বাটনে ট্যাপ করে <b>Enable</b> চাপলেই মেইল আসা শুরু হবে:`, rows([btn.url('⚡ ১ ক্লিকে Gmail API Enable করুন ↗', enableUrl, 'success')])).catch(() => {});
}
return;
}
throw e;
}
}
let running = false, pollerOn = false;
async function tick() {
if (running) return;
running = true;
try {
for (const acc of store.allGmail().filter((g) => g.refreshToken)) {
try { await pollAccount(acc); } catch (e) {
if (e.code === 'invalid_grant') store.upsertGmail({ email: acc.email, status: 'expired', lastError: 'টোকেনের মেয়াদ শেষ — আবার কানেক্ট করুন' });
}
}
} finally { running = false; }
}
export function startGmailPoller() {
if (!pollerOn) { pollerOn = true; setInterval(tick, config.google.pollMs); }
tick().catch(() => {});
}
export async function pollNow() {
clearGmailTokenCache();
try { await tick(); } catch {}
}