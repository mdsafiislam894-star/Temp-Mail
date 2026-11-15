import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';
import {
  b32ToBytes,
  totpAt,
  computeTotp,
  cleanTotpInput,
  parseBulkTotpInput,
  detectIssuer,
} from './lib/totp.js';

export { b32ToBytes, totpAt, computeTotp, cleanTotpInput, parseBulkTotpInput, detectIssuer };

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
if (!Array.isArray(db.seen)) db.seen = [];
if (!Array.isArray(db.messages)) db.messages = [];
if (!db.users || typeof db.users !== 'object') db.users = {};
if (!db.addresses || typeof db.addresses !== 'object') db.addresses = {};
if (!db.gmail || typeof db.gmail !== 'object') db.gmail = {};
if (typeof db.meta?.openAccess === 'boolean') config.openAccess = db.meta.openAccess;

const seenSet = new Set(db.seen);

export const getMeta = (k) => db.meta?.[k];
export function setMeta(k, v) {
  db.meta = { ...(db.meta || {}), [k]: v };
  save();
}

export function flush() {
  clearTimeout(timer);
  timer = null;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('⚠️ DB save failed:', e.message);
  }
}
const save = () => {
  if (!timer) {
    timer = setTimeout(flush, 350);
    timer.unref?.();
  }
};
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

export function setActiveCard(userId, chatId, messageId, addr = '', gotMail = false) {
  const u = db.users[String(userId)];
  if (u) {
    u.activeCard = {
      chatId: Number(chatId),
      messageId: Number(messageId),
      addr: String(addr || '').toLowerCase(),
      gotMail: Boolean(gotMail),
    };
    save();
  }
}
export const getActiveCard = (userId) => db.users[String(userId)]?.activeCard || null;

export function deleteUser(id) {
  const uid = String(id);
  if (!db.users[uid]) return false;
  delete db.users[uid];
  for (const [k, a] of Object.entries(db.addresses)) if (a.owner === uid) delete db.addresses[k];
  db.messages = db.messages.filter((m) => m.owner !== uid);
  for (const [k, g] of Object.entries(db.gmail)) if (g.owner === uid) delete db.gmail[k];
  db.totp = db.totp.filter((t) => t.owner !== uid);
  save();
  return true;
}

function resolveDomain(owner, domainOverride = '', label = '') {
  const doms = config.domains.length ? config.domains : ['safix.tech'];
  const escaped = doms.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const mDom = String(label || '').match(new RegExp(`^@(${escaped})\\|(.*)$`, 'i'));
  if (mDom) {
    return { domain: mDom[1].toLowerCase(), cleanLabel: mDom[2] };
  }
  const ov = String(domainOverride || '').trim().toLowerCase().replace(/^@+/, '');
  if (ov === 'random') {
    return { domain: doms[crypto.randomInt(doms.length)], cleanLabel: label };
  }
  if (ov && doms.includes(ov)) {
    return { domain: ov, cleanLabel: label };
  }
  const u = db.users[String(owner)];
  if (u && typeof u.prefDomain === 'number') {
    if (u.prefDomain === -1) return { domain: doms[crypto.randomInt(doms.length)], cleanLabel: label };
    if (u.prefDomain >= 0 && u.prefDomain < doms.length) return { domain: doms[u.prefDomain], cleanLabel: label };
  }
  return { domain: doms[crypto.randomInt(doms.length)], cleanLabel: label };
}

export function generateUniqueAddress(owner, customLocal = '', label = '', ttlMin = 0, domainOverride = '') {
  const { domain, cleanLabel } = resolveDomain(owner, domainOverride, label);
  const clean = String(customLocal || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
  if (clean) {
    const full = `${clean}@${domain}`;
    const ex = getAddress(full);
    if (ex) {
      if (ex.owner === String(owner)) {
        ex.createdAt = Date.now();
        if (cleanLabel) ex.label = String(cleanLabel).slice(0, 30);
        if (ttlMin > 0) {
          ex.ttl = ttlMin;
          ex.expiresAt = Date.now() + ttlMin * 60000;
          ex.expired = false;
        }
        save();
        return ex;
      }
      return null;
    }
    return createAddress(owner, full, cleanLabel, ttlMin);
  }
  for (let i = 0; i < 40; i++) {
    const w = ANIME_TECH_NAMES[crypto.randomInt(ANIME_TECH_NAMES.length)];
    const r = createAddress(owner, `${w}${crypto.randomInt(100, 10000)}@${domain}`, cleanLabel, ttlMin);
    if (r) return r;
  }
  while (true) {
    seqCounter = (seqCounter + 1) % 90000 + 10000;
    const w = ANIME_TECH_NAMES[crypto.randomInt(ANIME_TECH_NAMES.length)];
    const r = createAddress(owner, `${w}${seqCounter}@${domain}`, cleanLabel, ttlMin);
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

export function setPinnedAddress(owner, id, pinned = true) {
  const a = getAddressById(id);
  if (!a || a.owner !== String(owner)) return null;
  a.pinned = Boolean(pinned);
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
  if (!u) u = db.users[id] = { id, status, createdAt: Date.now(), prefDomain: -1 };
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
  if (u) { u.prefDomain = Number(idx); save(); }
}

// ---------- settings ----------
export const THEMES = [
  'aurora', 'claude', 'claude-light', 'midnight', 'obsidian', 'ocean', 'cobalt',
  'emerald', 'amber', 'crimson', 'rose', 'cyber', 'nebula', 'nord', 'daylight',
  'sky', 'mint', 'blush', 'auto',
];
export const STYLES = ['smart', 'rich', 'compact'];
export const SKINS = ['glass', 'claude', 'mix', 'bento', 'obsidian', 'minimal', 'editorial'];
export const TTLS = [0, 10, 60, 1440];

const LEGACY_THEME_MAP = { claydark: 'claude', clay: 'claude-light', pearl: 'daylight' };
const LEGACY_SKIN_MAP = {};

export const DEFAULT_SETTINGS = {
  notify: true,
  otpOnly: false,
  style: 'smart',
  theme: 'aurora',
  skin: 'glass',
  ttl: 0,
  muted: [],
  autoCopy: true,
  autoMarkReadOnCopy: false,
  sound: true,
  compact: false,
  liteBlur: false,
  otpFormat: 'spaced',
};

function normalizeTheme(t) {
  if (THEMES.includes(t)) return t;
  return LEGACY_THEME_MAP[t] || DEFAULT_SETTINGS.theme;
}
function normalizeSkin(s) {
  if (SKINS.includes(s)) return s;
  return LEGACY_SKIN_MAP[s] || DEFAULT_SETTINGS.skin;
}

export function getSettings(id) {
  const raw = db.users[String(id)]?.settings || {};
  const s = { ...DEFAULT_SETTINGS, ...raw };
  s.theme = normalizeTheme(s.theme);
  s.skin = normalizeSkin(s.skin);
  if (!STYLES.includes(s.style)) s.style = 'smart';
  if (!TTLS.includes(Number(s.ttl))) s.ttl = 0;
  if (!Array.isArray(s.muted)) s.muted = [];
  if (s.otpFormat !== 'plain' && s.otpFormat !== 'spaced') s.otpFormat = 'spaced';
  s.liteBlur = Boolean(s.liteBlur);
  return s;
}

export function setSettings(id, patch = {}) {
  const u = db.users[String(id)];
  if (!u) return null;
  const s = getSettings(id);
  if (typeof patch.notify === 'boolean') s.notify = patch.notify;
  if (typeof patch.otpOnly === 'boolean') s.otpOnly = patch.otpOnly;
  if (typeof patch.autoCopy === 'boolean') s.autoCopy = patch.autoCopy;
  if (typeof patch.autoMarkReadOnCopy === 'boolean') s.autoMarkReadOnCopy = patch.autoMarkReadOnCopy;
  if (typeof patch.sound === 'boolean') s.sound = patch.sound;
  if (typeof patch.compact === 'boolean') s.compact = patch.compact;
  if (typeof patch.liteBlur === 'boolean') s.liteBlur = patch.liteBlur;
  if (patch.otpFormat === 'plain' || patch.otpFormat === 'spaced') s.otpFormat = patch.otpFormat;
  if (STYLES.includes(patch.style)) s.style = patch.style;
  if (patch.theme) s.theme = normalizeTheme(patch.theme);
  if (patch.skin) s.skin = normalizeSkin(patch.skin);
  if (TTLS.includes(Number(patch.ttl))) s.ttl = Number(patch.ttl);
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
  Object.values(db.addresses)
    .filter((a) => a.owner === String(owner))
    .sort((a, b) => (Boolean(b.pinned) - Boolean(a.pinned)) || (b.createdAt - a.createdAt));

export function createAddress(owner, addr, label = '', ttlMin = 0) {
  addr = String(addr).toLowerCase();
  if (db.addresses[addr]) return null;
  const ttl = Math.max(0, Number(ttlMin) || 0);
  const now = Date.now();
  const rec = (db.addresses[addr] = {
    id: newId(3),
    addr,
    owner: String(owner),
    label: String(label || '').slice(0, 30),
    createdAt: now,
    ttl,
    expiresAt: ttl > 0 ? now + ttl * 60000 : 0,
    expired: false,
    pinned: false,
  });
  save();
  return rec;
}

export function ensureAddress(owner, addr, label = '', ttlMin = 0) {
  const ex = getAddress(addr);
  if (ex) return ex.owner === String(owner) ? ex : null;
  return createAddress(owner, addr, label, ttlMin);
}

export function setLabel(id, label) {
  const a = getAddressById(id);
  if (a) { a.label = String(label || '').slice(0, 30); save(); }
  return a;
}

export function setExpiry(id, ttlMin) {
  const a = getAddressById(id);
  if (!a) return null;
  const ttl = Math.max(0, Number(ttlMin) || 0);
  a.ttl = ttl;
  a.expiresAt = ttl > 0 ? Date.now() + ttl * 60000 : 0;
  a.expired = false;
  save();
  return a;
}

export function extendAddress(id, addMin) {
  const a = getAddressById(id);
  if (!a) return null;
  const add = Math.max(1, Number(addMin) || 60);
  a.expiresAt = Math.max(Date.now(), a.expiresAt || Date.now()) + add * 60000;
  a.expired = false;
  save();
  return a;
}

export function expireSweep() {
  const hit = [];
  const now = Date.now();
  for (const a of Object.values(db.addresses)) {
    if (a.expiresAt && !a.expired && a.expiresAt < now) {
      a.expired = true;
      hit.push(a);
    }
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
export const hasSeen = (key) => Boolean(key && seenSet.has(key));
export function markSeen(key) {
  if (!key || seenSet.has(key)) return;
  seenSet.add(key);
  db.seen.push(key);
  if (db.seen.length > 6000) {
    db.seen = db.seen.slice(-4000);
    seenSet.clear();
    for (const k of db.seen) seenSet.add(k);
  }
  save();
}

export function addMessage(m) {
  const msg = { id: newId(4), read: false, pinned: false, ...m, owner: String(m.owner) };
  db.messages.push(msg);
  markSeen(m.key);
  prune();
  save();
  return msg;
}

function prune() {
  const min = Date.now() - config.retentionDays * 86400000;
  db.messages = db.messages.filter((m) => m.pinned || m.date >= min);
  const per = new Map();
  for (let i = db.messages.length - 1; i >= 0; i--) {
    const o = db.messages[i].owner;
    const n = (per.get(o) || 0) + 1;
    per.set(o, n);
    if (n > config.maxPerUser && !db.messages[i].pinned) db.messages.splice(i, 1);
  }
}

export const getMessage = (id) => db.messages.find((m) => m.id === id) || null;

export function listMessages(owner, { limit = 50, before = Infinity, q = '', filter = 'all', addr = '' } = {}) {
  const needle = String(q || '').toLowerCase().trim();
  const targetAddr = String(addr || '').toLowerCase().trim();
  return db.messages
    .filter((m) => (owner === null ? true : m.owner === String(owner)) && m.date < before)
    .filter((m) => !targetAddr || String(m.to || '').toLowerCase() === targetAddr)
    .filter((m) => {
      if (filter === 'unread') return !m.read;
      if (filter === 'otp') return Boolean(m.otp);
      if (filter === 'link') return Boolean(m.links && m.links.length);
      if (filter === 'pinned') return Boolean(m.pinned);
      if (filter === 'gmail') return m.source === 'gmail' || String(m.to || '').endsWith('@gmail.com');
      if (filter === 'domain') return m.source !== 'gmail' && !String(m.to || '').endsWith('@gmail.com');
      return true;
    })
    .filter((m) => {
      if (!needle) return true;
      const hay = `${m.subject || ''} ${m.to || ''} ${m.service?.name || ''} ${m.from || ''} ${m.otp || ''} ${m.text || ''}`.toLowerCase();
      return hay.includes(needle);
    })
    .sort((a, b) => b.date - a.date)
    .slice(0, limit);
}

export function markRead(id) {
  const m = getMessage(id);
  if (m && !m.read) { m.read = true; save(); }
  return m;
}

export function pinMessage(owner, id, pinned = true) {
  const m = getMessage(id);
  if (!m || (owner !== null && m.owner !== String(owner))) return null;
  m.pinned = Boolean(pinned);
  save();
  return m;
}

export function deleteMessage(id) {
  const i = db.messages.findIndex((m) => m.id === id);
  if (i >= 0) { db.messages.splice(i, 1); save(); return true; }
  return false;
}

export function deleteMessagesByAddress(owner, addr) {
  const target = String(addr || '').toLowerCase();
  const before = db.messages.length;
  db.messages = db.messages.filter((m) => !(m.owner === String(owner) && String(m.to || '').toLowerCase() === target));
  const removed = before - db.messages.length;
  if (removed) save();
  return removed;
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

export function countStats(owner) {
  let total = 0;
  let unread = 0;
  let otp = 0;
  let pinned = 0;
  const uid = String(owner);
  for (const m of db.messages) {
    if (m.owner !== uid) continue;
    total++;
    if (!m.read) unread++;
    if (m.otp) otp++;
    if (m.pinned) pinned++;
  }
  return { total, unread, otp, pinned };
}

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
    totp: db.totp.length,
  };
}

// ---------- 2FA / TOTP Authenticator Vault ----------
function serializeTotpItem(t, now = Date.now()) {
  const live = computeTotp(t.secret, now, { algo: t.algo, digits: t.digits, period: t.period });
  const masked = t.secret.length > 8 ? `${t.secret.slice(0, 4)}••••${t.secret.slice(-4)}` : '••••';
  return {
    id: t.id,
    name: t.name,
    issuer: t.issuer || '',
    category: t.category || 'General',
    secret: t.secret,
    masked,
    pinned: Boolean(t.pinned),
    createdAt: t.createdAt,
    ...live,
  };
}

export function listTotp(owner) {
  const now = Date.now();
  return db.totp
    .filter((t) => !owner || t.owner === String(owner) || String(owner) === config.adminId)
    .sort((a, b) => (Boolean(b.pinned) - Boolean(a.pinned)) || (b.createdAt - a.createdAt))
    .map((t) => serializeTotpItem(t, now));
}

export function addTotp(owner, name, rawSecret, customId = '', meta = {}) {
  const parsed = cleanTotpInput(name, rawSecret);
  const cleanLabel = meta.name?.trim() || parsed.name;
  const secret = parsed.secret;
  if (secret.length < 4 || !b32ToBytes(secret).length) return null;

  const issuer = meta.issuer?.trim() || parsed.issuer || detectIssuer(cleanLabel).issuer;
  const category = meta.category?.trim() || parsed.category || detectIssuer(cleanLabel, issuer).category;
  const algo = meta.algo || parsed.algo || 'SHA1';
  const digits = meta.digits || parsed.digits || 6;
  const period = meta.period || parsed.period || 30;

  if (customId) {
    const byId = db.totp.find((t) => t.id === customId);
    if (byId) {
      byId.name = cleanLabel || byId.name;
      byId.secret = secret;
      byId.issuer = issuer || byId.issuer;
      byId.category = category || byId.category;
      byId.algo = algo;
      byId.digits = digits;
      byId.period = period;
      if (typeof meta.pinned === 'boolean') byId.pinned = meta.pinned;
      save();
      return serializeTotpItem(byId);
    }
  }
  const ex = db.totp.find(
    (t) => t.owner === String(owner) && t.secret === secret && t.name.toLowerCase() === cleanLabel.toLowerCase(),
  );
  if (ex) {
    ex.name = cleanLabel || ex.name;
    ex.issuer = issuer || ex.issuer;
    ex.category = category || ex.category;
    ex.algo = algo;
    ex.digits = digits;
    ex.period = period;
    ex.createdAt = Date.now();
    save();
    return serializeTotpItem(ex);
  }
  const item = {
    id: customId || newId(4),
    owner: String(owner),
    name: cleanLabel,
    issuer,
    category,
    secret,
    algo,
    digits,
    period,
    pinned: Boolean(meta.pinned),
    createdAt: Date.now(),
  };
  db.totp.push(item);
  save();
  return serializeTotpItem(item);
}

export function importTotpBulk(owner, rawOrList, fallbackName = '') {
  const entries = Array.isArray(rawOrList)
    ? rawOrList.flatMap((it) => (it && it.secret ? [cleanTotpInput(it.name || fallbackName, it.secret)] : []))
    : parseBulkTotpInput(rawOrList, fallbackName);
  const added = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const extra = Array.isArray(rawOrList) && rawOrList[i] ? rawOrList[i] : {};
    const saved = addTotp(owner, e.name, e.secret, extra.id || '', {
      issuer: extra.issuer || e.issuer,
      category: extra.category || e.category,
      algo: extra.algo || e.algo,
      digits: extra.digits || e.digits,
      period: extra.period || e.period,
      pinned: extra.pinned,
    });
    if (saved) added.push(saved);
  }
  return added;
}

export function updateTotp(owner, id, { name, secret, issuer, category, algo, digits, period, pinned } = {}) {
  const item = db.totp.find((t) => t.id === id && (t.owner === String(owner) || String(owner) === config.adminId));
  if (!item) return null;
  if (typeof name === 'string' && name.trim()) item.name = name.trim().slice(0, 60);
  if (typeof issuer === 'string') item.issuer = issuer.trim().slice(0, 40);
  if (typeof category === 'string' && category.trim()) item.category = category.trim().slice(0, 30);
  if (algo === 'SHA1' || algo === 'SHA256' || algo === 'SHA512') item.algo = algo;
  if (Number(digits) === 6 || Number(digits) === 8) item.digits = Number(digits);
  if (Number(period) >= 15 && Number(period) <= 120) item.period = Number(period);
  if (typeof pinned === 'boolean') item.pinned = pinned;
  if (typeof secret === 'string' && secret.trim()) {
    const cleaned = cleanTotpInput(item.name, secret).secret;
    if (cleaned.length >= 4 && b32ToBytes(cleaned).length > 0) item.secret = cleaned;
  }
  save();
  return serializeTotpItem(item);
}

export function pinTotp(owner, id, pinned = true) {
  return updateTotp(owner, id, { pinned });
}

export function removeTotp(owner, id) {
  const idx = db.totp.findIndex((t) => t.id === id && (t.owner === String(owner) || String(owner) === config.adminId));
  if (idx >= 0) { db.totp.splice(idx, 1); save(); return true; }
  return false;
}

export function exportTotp(owner) {
  return listTotp(owner).map(({ id, name, issuer, category, secret, algo, digits, period, pinned, createdAt }) => ({
    id, name, issuer, category, secret, algo, digits, period, pinned, createdAt,
  }));
}

export function exportUserBackup(owner) {
  const uid = String(owner);
  const u = getUser(uid);
  return {
    version: 4,
    exportedAt: Date.now(),
    prefDomain: u?.prefDomain ?? -1,
    settings: getSettings(uid),
    addresses: listAddresses(uid).map(({ id, addr, label, ttl, expiresAt, expired, pinned, createdAt }) => ({
      id, addr, label, ttl, expiresAt, expired, pinned, createdAt,
    })),
    totp: exportTotp(uid),
    gmails: listGmail(uid).map(({ email, refreshToken, imapPass, clientId, clientSecret, status, connectedAt }) => ({
      email, refreshToken, imapPass, clientId, clientSecret, status, connectedAt,
    })),
  };
}

export function restoreUserBackup(owner, backup = {}) {
  const uid = String(owner);
  let restoredAddrs = 0;
  let restoredTotp = 0;
  let restoredGmails = 0;

  if (typeof backup.prefDomain === 'number') setPrefDomain(uid, backup.prefDomain);
  if (backup.settings && typeof backup.settings === 'object') setSettings(uid, backup.settings);

  if (Array.isArray(backup.addresses)) {
    for (const a of backup.addresses.slice(0, 60)) {
      if (!a || !a.addr) continue;
      const domain = String(a.addr).split('@')[1]?.toLowerCase();
      if (!domain || !config.domains.includes(domain)) continue;
      const rec = ensureAddress(uid, a.addr, a.label || '', a.ttl || 0);
      if (rec) {
        if (a.pinned) rec.pinned = true;
        restoredAddrs++;
      }
    }
  }
  if (Array.isArray(backup.totp)) {
    const imported = importTotpBulk(uid, backup.totp);
    restoredTotp = imported.length;
  }
  if (Array.isArray(backup.gmails)) {
    for (const g of backup.gmails) {
      if (!g || !g.email || (db.gmail[g.email] && db.gmail[g.email].owner !== uid)) continue;
      upsertGmail({
        email: g.email,
        owner: uid,
        refreshToken: g.refreshToken || '',
        imapPass: g.imapPass || '',
        clientId: g.clientId || '',
        clientSecret: g.clientSecret || '',
        status: g.status || 'active',
        connectedAt: g.connectedAt || Date.now(),
      });
      restoredGmails++;
    }
  }
  save();
  return { restoredAddrs, restoredTotp, restoredGmails };
}
