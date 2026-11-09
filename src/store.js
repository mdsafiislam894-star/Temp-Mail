import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';

const FILE = path.join(config.dataDir, 'db.json');
let db = { users: {}, addresses: {}, messages: [], gmail: {}, totp: [], seen: [], meta: {} };
let timer = null;

try {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (fs.existsSync(FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch (e) {
  console.error('⚠️ DB load failed, starting empty:', e.message);
}

if (!Array.isArray(db.totp)) db.totp = [];
if (typeof db.meta?.openAccess === 'boolean') config.openAccess = db.meta.openAccess;
export const getMeta = (k) => db.meta?.[k];
export function setMeta(k, v) { db.meta = { ...(db.meta || {}), [k]: v }; save(); }

export function flush() {
  clearTimeout(timer);
  timer = null;
  try {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('⚠️ DB save failed:', e.message); }
}
const save = () => { if (!timer) timer = setTimeout(flush, 400); };
process.on('exit', flush);

export const ANIME_TECH_NAMES = [
  'gojo','sukuna','itachi','sasuke','naruto','kakashi','minato','madara','obito','jiraiya',
  'levi','eren','mikasa','armin','zoro','luffy','sanji','shanks','ace','law','yamato','ichigo',
  'aizen','byakuya','urahara','ulquiorra','zaraki','killua','gon','hisoka','kurapika','chrollo',
  'tanjiro','zenitsu','inosuke','rengoku','giyu','tengen','muichiro','akaza','goku','vegeta',
  'gohan','trunks','broly','vegetto','gogeta','saitama','genos','garou','kaneki','touka','light',
  'ryuk','lawliet','elric','mustang','anya','loid','yor','denji','makima','aki','power','rimuru',
  'veldora','diablo','ainz','subaru','emilia','rem','kirito','asuna','lelouch','thorfinn','baki',
  'yujiro','jotaro','dio','giorno','deku','bakugo','todoroki','dabi','frieren','fern','stark',
  'jinwoo','igris','beru','isagi','bachira','nagi','rin','kaiser','cid','shadow','alpha','asta',
  'yuno','yami','senku','mob','reigen','alucard','spike','guts','griffith','shinra','dazai',
  'cyber','nexus','quantum','matrix','photon','vortex','vector','cipher','specter','blade',
  'neural','synapse','silicon','plasma','quasar','pulsar','nebula','hyperion','aether','zenith',
  'apex','chrono','sonic','binary','pixel','crypto','stratos','cobalt','argon','krypton','helix',
  'omega','delta','titan','nova','flux','orbit','prism','vertex','axiom'
];
let seqCounter = crypto.randomInt(1000, 9000);
for (const a of Object.values(db.addresses || {})) { a.ttl = 0; a.expiresAt = 0; a.expired = false; }

export function setActiveCard(userId, chatId, messageId, addr = '') {
  const u = db.users[String(userId)];
  if (u) { u.activeCard = { chatId: Number(chatId), messageId: Number(messageId), addr: String(addr || '').toLowerCase() }; save(); }
}
export const getActiveCard = (userId) => db.users[String(userId)]?.activeCard || null;

export function deleteUser(id) {
  const uid = String(id);
  if (!db.users[uid]) return false;
  delete db.users[uid];
  for (const [k, a] of Object.entries(db.addresses)) if (a.owner === uid) delete db.addresses[k];
  db.messages = db.messages.filter((m) => m.owner !== uid);
  for (const [k, g] of Object.entries(db.gmail)) if (g.owner === uid) delete db.gmail[k];
  db.totp = (db.totp || []).filter((t) => t.owner !== uid);
  save();
  return true;
}

export function generateUniqueAddress(owner, customLocal = '', label = '', ttlMin = 0) {
  const domain = 'safix.tech';
  const clean = String(customLocal || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
  if (clean) {
    const full = `${clean}@${domain}`;
    const ex = getAddress(full);
    if (ex) {
      if (ex.owner === String(owner)) { ex.createdAt = Date.now(); save(); return ex; }
      return null;
    }
    return createAddress(owner, full, label, ttlMin);
  }
  for (let i = 0; i < 40; i++) {
    const w = ANIME_TECH_NAMES[crypto.randomInt(ANIME_TECH_NAMES.length)];
    const r = createAddress(owner, `${w}${crypto.randomInt(100, 10000)}@${domain}`, label, ttlMin);
    if (r) return r;
  }
  while (true) {
    seqCounter = (seqCounter + 1) % 90000 + 10000;
    const w = ANIME_TECH_NAMES[crypto.randomInt(ANIME_TECH_NAMES.length)];
    const r = createAddress(owner, `${w}${seqCounter}@${domain}`, label, ttlMin);
    if (r) return r;
  }
}

export function setPrimaryAddress(owner, id) {
  const a = getAddressById(id);
  if (!a || a.owner !== String(owner)) return null;
  a.createdAt = Date.now() + 1000;
  save();
  return a;
}

export const newId = (bytes = 4) => crypto.randomBytes(bytes).toString('hex');

// ---------- users ----------
export const getUser = (id) => db.users[String(id)] || null;
export const listUsers = () => Object.values(db.users);

export function touchUser(from, status) {
  const id = String(from.id);
  let u = db.users[id];
  const isNew = !u;
  if (!u) u = db.users[id] = { id, status, createdAt: Date.now(), prefDomain: 0 };
  u.name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || id;
  u.username = from.username || '';
  u.lastSeen = Date.now();
  if (status === 'approved' && u.status === 'pending') u.status = 'approved';
  save();
  return { user: u, isNew };
}
export function setUserStatus(id, status) {
  const u = db.users[String(id)];
  if (u) { u.status = status; save(); }
  return u;
}
export function setPrefDomain(id, idx) {
  const u = db.users[String(id)];
  if (u) { u.prefDomain = idx; save(); }
}

// ---------- settings ----------
export const THEMES = ['auto', 'aurora', 'ocean', 'emerald', 'rose', 'obsidian', 'cyber', 'nebula', 'pearl', 'sky', 'blush', 'mint', 'clay', 'claydark'];
export const STYLES = ['smart', 'rich', 'compact'];
export const SKINS = ['glass', 'claude', 'mix'];
export const TTLS = [0, 10, 60, 1440];
export const DEFAULT_SETTINGS = { notify: true, otpOnly: false, style: 'smart', theme: 'aurora', skin: 'glass', ttl: 0, muted: [] };

export function getSettings(id) {
  const raw = db.users[String(id)]?.settings || {};
  if (!raw._v10) {
    raw.skin = 'glass';
    if (!raw.theme || raw.theme === 'clay' || raw.theme === 'claydark' || raw.theme === 'auto') raw.theme = 'aurora';
    raw._v10 = true;
    if (db.users[String(id)]) { db.users[String(id)].settings = raw; save(); }
  }
  const s = { ...DEFAULT_SETTINGS, ...raw };
  if (!STYLES.includes(s.style)) s.style = 'smart';
  if (!SKINS.includes(s.skin)) s.skin = 'glass';
  if (!Array.isArray(s.muted)) s.muted = [];
  return s;
}
export function setSettings(id, patch = {}) {
  const u = db.users[String(id)];
  if (!u) return null;
  const s = getSettings(id);
  if (typeof patch.notify === 'boolean') s.notify = patch.notify;
  if (typeof patch.otpOnly === 'boolean') s.otpOnly = patch.otpOnly;
  if (STYLES.includes(patch.style)) s.style = patch.style;
  if (THEMES.includes(patch.theme)) s.theme = patch.theme;
  if (SKINS.includes(patch.skin)) s.skin = patch.skin;
  if (TTLS.includes(patch.ttl)) s.ttl = patch.ttl;
  if (typeof patch.mute === 'string' && patch.mute.trim()) {
    const n = patch.mute.trim().slice(0, 40);
    if (!s.muted.includes(n) && s.muted.length < 30) s.muted = [...s.muted, n];
  }
  if (typeof patch.unmute === 'string') s.muted = s.muted.filter((x) => x !== patch.unmute);
  u.settings = s;
  save();
  return s;
}

// ---------- addresses ----------
export const getAddress = (addr) => db.addresses[String(addr).toLowerCase()] || null;
export const getAddressById = (id) => Object.values(db.addresses).find((a) => a.id === id) || null;
export const listAddresses = (owner) =>
  Object.values(db.addresses).filter((a) => a.owner === String(owner)).sort((a, b) => b.createdAt - a.createdAt);

export function createAddress(owner, addr, label = '', ttlMin = 0) {
  addr = addr.toLowerCase();
  if (db.addresses[addr]) return null;
  const ttl = Number(ttlMin) || 0;
  const rec = (db.addresses[addr] = {
    id: newId(3), addr, owner: String(owner), label, createdAt: Date.now(),
    ttl, expiresAt: ttl > 0 ? Date.now() + ttl * 60000 : 0, expired: false,
  });
  save();
  return rec;
}
export function ensureAddress(owner, addr) {
  const ex = getAddress(addr);
  if (ex) return ex.owner === String(owner) ? ex : null;
  return createAddress(owner, addr);
}
export function setLabel(id, label) {
  const a = getAddressById(id);
  if (a) { a.label = label.slice(0, 30); save(); }
  return a;
}
export function setExpiry(id, ttlMin) {
  const a = getAddressById(id);
  if (!a) return null;
  a.ttl = ttlMin || 0; a.expiresAt = ttlMin ? Date.now() + ttlMin * 60000 : 0; a.expired = false;
  save();
  return a;
}
export function extendAddress(id, addMin) {
  const a = getAddressById(id);
  if (!a) return null;
  a.expiresAt = Math.max(Date.now(), a.expiresAt || 0) + addMin * 60000; a.expired = false;
  save();
  return a;
}
export function expireSweep() {
  const hit = [];
  for (const a of Object.values(db.addresses)) {
    if (a.expiresAt && !a.expired && a.expiresAt < Date.now()) { a.expired = true; hit.push(a); }
  }
  if (hit.length) save();
  return hit;
}
export function deleteAddress(id) {
  const a = getAddressById(id);
  if (a) { delete db.addresses[a.addr]; save(); }
  return a;
}

// ---------- messages ----------
export const hasSeen = (key) => db.seen.includes(key);
export function markSeen(key) {
  if (!key) return;
  db.seen.push(key);
  if (db.seen.length > 3000) db.seen = db.seen.slice(-2000);
  save();
}
export function addMessage(m) {
  const msg = { id: newId(4), read: false, ...m, owner: String(m.owner) };
  db.messages.push(msg);
  markSeen(m.key);
  prune();
  save();
  return msg;
}
function prune() {
  const min = Date.now() - config.retentionDays * 86400000;
  db.messages = db.messages.filter((m) => m.date >= min);
  const per = new Map();
  for (let i = db.messages.length - 1; i >= 0; i--) {
    const o = db.messages[i].owner;
    const n = (per.get(o) || 0) + 1;
    per.set(o, n);
    if (n > config.maxPerUser) db.messages.splice(i, 1);
  }
}
export const getMessage = (id) => db.messages.find((m) => m.id === id) || null;
export function listMessages(owner, { limit = 30, before = Infinity, q = '' } = {}) {
  const needle = q.toLowerCase();
  return db.messages
    .filter((m) => (owner === null ? true : m.owner === String(owner)) && m.date < before)
    .filter((m) => !needle || `${m.subject} ${m.to} ${m.service?.name} ${m.from}`.toLowerCase().includes(needle))
    .sort((a, b) => b.date - a.date)
    .slice(0, limit);
}
export function markRead(id) { const m = getMessage(id); if (m && !m.read) { m.read = true; save(); } return m; }
export function deleteMessage(id) {
  const i = db.messages.findIndex((m) => m.id === id);
  if (i >= 0) { db.messages.splice(i, 1); save(); return true; }
  return false;
}
export function markAllRead(owner) {
  let n = 0;
  for (const m of db.messages) if (m.owner === String(owner) && !m.read) { m.read = true; n++; }
  if (n) save();
  return n;
}
export function clearMessages(owner) {
  const before = db.messages.length;
  db.messages = db.messages.filter((m) => m.owner !== String(owner));
  save();
  return before - db.messages.length;
}
export const countUnread = (owner) => db.messages.filter((m) => m.owner === String(owner) && !m.read).length;

// ---------- gmail ----------
export const listGmail = (owner) => Object.values(db.gmail).filter((g) => g.owner === String(owner));
export const allGmail = () => Object.values(db.gmail);
export function upsertGmail(rec) {
  db.gmail[rec.email] = { ...(db.gmail[rec.email] || {}), ...rec };
  save();
  return db.gmail[rec.email];
}
export function removeGmail(owner, email) {
  const g = db.gmail[email];
  if (g && g.owner === String(owner)) { delete db.gmail[email]; save(); return true; }
  return false;
}

export function activity(owner = null, hours = 24) {
  const out = Array(hours).fill(0);
  const now = Date.now();
  for (const m of db.messages) {
    if (owner && m.owner !== String(owner)) continue;
    const h = Math.floor((now - m.date) / 3600000);
    if (h >= 0 && h < hours) out[hours - 1 - h]++;
  }
  return out;
}
export function usersDetailed() {
  return listUsers().map((u) => ({
    id: u.id, name: u.name, username: u.username, status: u.status, lastSeen: u.lastSeen || 0, createdAt: u.createdAt || 0,
    addresses: Object.values(db.addresses).filter((a) => a.owner === u.id && !a.expired).length,
    messages: db.messages.filter((m) => m.owner === u.id).length,
  }));
}
export function stats() {
  const users = listUsers();
  return {
    users: users.length,
    pending: users.filter((u) => u.status === 'pending').length,
    banned: users.filter((u) => u.status === 'banned').length,
    addresses: Object.keys(db.addresses).length,
    messages: db.messages.length,
    today: db.messages.filter((m) => m.date > Date.now() - 86400000).length,
    expired: Object.values(db.addresses).filter((a) => a.expired).length,
    gmail: Object.keys(db.gmail).length,
    totp: (db.totp || []).length,
  };
}

// ---------- 2FA / TOTP Authenticator (RFC 6238 / 2fa.cn + Google Authenticator) ----------
export function b32ToBytes(raw) {
  let s = String(raw || '').trim();
  if (s.startsWith('otpauth://')) {
    try { const u = new URL(s); s = u.searchParams.get('secret') || s; } catch {}
  }
  const clean = s.toUpperCase().replace(/[\s\-=]+/g, '');
  if (!clean) return Buffer.alloc(0);
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  if (/^[A-Z2-7]+$/.test(clean)) {
    let bits = 0, val = 0; const out = [];
    for (let i = 0; i < clean.length; i++) {
      val = (val << 5) | alpha.indexOf(clean[i]);
      bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
  }
  if (/^[0-9A-F]+$/i.test(clean) && clean.length % 2 === 0) {
    return Buffer.from(clean, 'hex');
  }
  const mapped = clean.replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B').replace(/[^A-Z2-7]/g, 'A');
  let bits = 0, val = 0; const out = [];
  for (let i = 0; i < mapped.length; i++) {
    val = (val << 5) | alpha.indexOf(mapped[i]);
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totpAt(secret, counter) {
  const key = b32ToBytes(secret);
  if (!key.length) return '------';
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[19] & 0xf;
  const code = (((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 1000000;
  return String(code).padStart(6, '0');
}

export function computeTotp(secret, nowMs = Date.now()) {
  const sec = Math.floor(nowMs / 1000);
  const counter = Math.floor(sec / 30);
  const remaining = 30 - (sec % 30);
  return {
    code: totpAt(secret, counter),
    nextCode: totpAt(secret, counter + 1),
    remaining,
  };
}

export function cleanTotpInput(name = '', rawSecret = '') {
  let s = String(rawSecret || '').trim();
  let label = String(name || '').trim();
  if (s.startsWith('otpauth://')) {
    try {
      const u = new URL(s);
      const pathLbl = decodeURIComponent(u.pathname.replace(/^\/+totp\/*/i, '')).trim();
      const iss = u.searchParams.get('issuer') || '';
      if (!label) label = iss && pathLbl && !pathLbl.startsWith(iss) ? `${iss} (${pathLbl})` : (iss || pathLbl);
      s = u.searchParams.get('secret') || s;
    } catch {}
  }
  const secret = s.toUpperCase().replace(/[\s\-=]+/g, '');
  return { name: (label || '2FA Account').slice(0, 60), secret };
}

export function listTotp(owner) {
  if (!Array.isArray(db.totp)) db.totp = [];
  const now = Date.now();
  return db.totp
    .filter((t) => !owner || t.owner === String(owner) || String(owner) === config.adminId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((t) => {
      const live = computeTotp(t.secret, now);
      const masked = t.secret.length > 8 ? `${t.secret.slice(0, 4)}••••${t.secret.slice(-4)}` : '••••';
      return { id: t.id, name: t.name, secret: t.secret, masked, createdAt: t.createdAt, ...live };
    });
}

export function addTotp(owner, name, rawSecret, customId = '') {
  if (!Array.isArray(db.totp)) db.totp = [];
  const { name: cleanLabel, secret } = cleanTotpInput(name, rawSecret);
  if (secret.length < 4 || !b32ToBytes(secret).length) return null;
  if (customId) {
    const byId = db.totp.find((t) => t.id === customId);
    if (byId) {
      byId.name = cleanLabel || byId.name;
      byId.secret = secret;
      save();
      return { ...byId, ...computeTotp(byId.secret) };
    }
  }
  const ex = db.totp.find((t) => t.owner === String(owner) && t.secret === secret && t.name.toLowerCase() === cleanLabel.toLowerCase());
  if (ex) {
    ex.name = cleanLabel || ex.name;
    ex.createdAt = Date.now();
    save();
    return { ...ex, ...computeTotp(ex.secret) };
  }
  const item = { id: customId || newId(4), owner: String(owner), name: cleanLabel, secret, createdAt: Date.now() };
  db.totp.push(item);
  save();
  return { ...item, ...computeTotp(item.secret) };
}

export function updateTotp(owner, id, { name, secret } = {}) {
  if (!Array.isArray(db.totp)) db.totp = [];
  const item = db.totp.find((t) => t.id === id && (t.owner === String(owner) || String(owner) === config.adminId));
  if (!item) return null;
  if (typeof name === 'string' && name.trim()) item.name = name.trim().slice(0, 60);
  if (typeof secret === 'string' && secret.trim()) {
    const cleaned = cleanTotpInput(item.name, secret).secret;
    if (cleaned.length >= 4 && b32ToBytes(cleaned).length > 0) item.secret = cleaned;
  }
  save();
  return { ...item, ...computeTotp(item.secret) };
}

export function removeTotp(owner, id) {
  if (!Array.isArray(db.totp)) db.totp = [];
  const idx = db.totp.findIndex((t) => t.id === id && (t.owner === String(owner) || String(owner) === config.adminId));
  if (idx >= 0) { db.totp.splice(idx, 1); save(); return true; }
  return false;
}
