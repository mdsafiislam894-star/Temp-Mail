// Dependency-free mail helpers. Shared by the Node bot AND the Cloudflare Worker.

export const escapeHtml = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', zwnj: '', zwj: '' };
export function decodeEntities(s = '') {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    const k = e.toLowerCase();
    return k in ENT ? ENT[k] : m;
  });
}

export function htmlToText(html = '') {
  return decodeEntities(
    String(html)
      .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[\u200b-\u200f\u2060\ufeff\u00ad\u034f]/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- sender / service ----------
export function parseAddress(str = '') {
  const m = String(str).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), address: m[2].trim().toLowerCase() };
  return { name: '', address: String(str).trim().toLowerCase() };
}

const SERVICES = [
  ['Telegram', '✈️', /telegram|\bt\.me\b/i],
  ['WhatsApp', '💬', /whatsapp/i],
  ['GitHub', '🐙', /github/i],
  ['Google', '🔴', /google|gmail|youtube/i],
  ['Meta', '🔵', /facebook|\bmeta\b|fb\.com/i],
  ['Instagram', '📸', /instagram/i],
  ['Netflix', '🎬', /netflix/i],
  ['Microsoft', '🪟', /microsoft|outlook|live\.com|office365/i],
  ['Apple', '🍏', /\bapple\b|icloud/i],
  ['Discord', '👾', /discord/i],
  ['X (Twitter)', '🐦', /twitter|\bx\.com\b/i],
  ['Amazon', '📦', /amazon|\baws\b/i],
  ['OpenAI', '🤖', /openai|chatgpt/i],
  ['Binance', '🪙', /binance/i],
  ['PayPal', '💳', /paypal/i],
  ['Steam', '🎮', /steam(powered|community)?\b/i],
  ['Uber', '🚗', /\buber\b/i],
  ['TikTok', '🎵', /tiktok/i],
  ['LinkedIn', '💼', /linkedin/i],
  ['Netspend', '💳', /netspend/i],
];

export function detectService({ from = '', subject = '', text = '' } = {}) {
  const sender = parseAddress(from);
  const tiers = [`${sender.name} ${sender.address}`, subject, String(text).slice(0, 400)];
  for (const hay of tiers) {
    for (const [name, icon, re] of SERVICES) if (re.test(hay)) return { name, icon };
  }
  const domain = sender.address.split('@')[1] || '';
  const parts = domain.split('.').filter(Boolean);
  if (sender.name && !sender.name.includes('@') && sender.name.length <= 28) return { name: sender.name, icon: '🌐' };
  if (parts.length >= 2) {
    const base = parts.length > 2 ? parts.slice(-2).join('.') : domain;
    return { name: base.charAt(0).toUpperCase() + base.slice(1), icon: '🌐' };
  }
  return { name: 'Mail Service', icon: '✉️' };
}

// ---------- OTP ----------
const YEAR = /^(19|20)\d{2}$/;
const clean = (v) => v.replace(/[ -]/g, '');

export function extractOtp(subject = '', text = '') {
  const flat = `${subject}\n${text}`.replace(/\s+/g, ' ');

  const p1 = /(?:code|otp|pin|passcode|token|কোড|ওটিপি)\b[^\d]{0,40}?(\d{3}[ -]\d{3}|\d{4,8})(?!\d)/gi;
  let m;
  while ((m = p1.exec(flat))) {
    const v = clean(m[1]);
    if (!YEAR.test(v)) return v;
  }

  const p2 = /(?<!\d)(\d{4,8})(?!\d)\s+(?:is|as)\s+(?:your|the|my)\b/gi;
  while ((m = p2.exec(flat))) if (!YEAR.test(m[1])) return m[1];

  const looksLikeAuth = /verif|code|otp|confirm|login|log in|sign in|passcode/i.test(flat.slice(0, 800));
  if (looksLikeAuth) {
    const line = String(text).match(/^\s*(\d{4,8})\s*$/m);
    if (line && !YEAR.test(line[1])) return line[1];
    const sub = String(subject).match(/(?<!\d)(\d{3}[ -]?\d{3}|\d{4,8})(?!\d)/);
    if (sub && /code|otp|verif|pin/i.test(subject) && !YEAR.test(clean(sub[1]))) return clean(sub[1]);
  }
  return null;
}

// ---------- links ----------
const BAD_URL = /unsubscribe|opt-?out|privacy|terms|legal|policies|preferences|\.(png|jpe?g|gif|svg|webp|css|ico)(\?|$)|w3\.org|schema\.org|pixel|open\.gif|beacon/i;
const GOOD = /verify|confirm|activate|validate|magic|log-?in|sign-?in|auth|token|reset|password|unblock|approve|accept/i;

export function extractLinks(html = '', text = '', max = 4) {
  const found = new Map();
  const add = (rawUrl, rawLabel = '', order = 0) => {
    const url = decodeEntities(rawUrl).trim();
    if (!/^https?:\/\//i.test(url) || url.length > 1900 || BAD_URL.test(url)) return;
    const label = htmlToText(rawLabel).replace(/\s+/g, ' ').slice(0, 26);
    let score = 0;
    if (GOOD.test(url)) score += 3;
    if (GOOD.test(label)) score += 2;
    if (/click|get started|open|continue|view/i.test(label)) score += 1;
    const prev = found.get(url);
    if (!prev || score > prev.score) {
      let host = '';
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return; }
      found.set(url, { url, label: label || host, host, score, order: prev ? prev.order : order });
    }
  };
  let n = 0;
  const a = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = a.exec(html))) add(m[1], m[2], n++);
  const raw = /https?:\/\/[^\s<>"'`)\]}]+/gi;
  const src = text || htmlToText(html);
  while ((m = raw.exec(src))) add(m[0].replace(/[.,;:!?]+$/, ''), '', n++);
  return [...found.values()].sort((x, y) => y.score - x.score || x.order - y.order).slice(0, max);
}

// ---------- purpose / details ----------
const PURPOSES = [
  [/password|reset/i, 'Password Reset'],
  [/unblock/i, 'Account Unblock Alert'],
  [/login|log in|sign.?in/i, 'Login Verification'],
  [/new device|device/i, 'Device Verification'],
  [/registration|sign.?up|create.*account|welcome/i, 'Registration Code'],
  [/verif|confirm|activate/i, 'Email Verification'],
];

export function detectPurpose(subject = '', text = '') {
  for (const hay of [subject, String(text).slice(0, 600)]) {
    for (const [re, label] of PURPOSES) if (re.test(hay)) return label;
  }
  const s = subject.trim();
  return s && s.toLowerCase() !== '(no subject)' ? s.slice(0, 40) : 'New Message';
}

export function extractDetails(text = '', subject = '') {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /^(device|location|ip address|browser)\s*:/i.test(l) && l.length < 80);
  if (hit) return hit;
  const use = lines.find((l) => /(use it to|enter the|valid for|expires)/i.test(l) && l.length < 70);
  if (use) return use;
  const s = subject.trim();
  return s && s.toLowerCase() !== '(no subject)' ? s.slice(0, 60) : 'নতুন মেসেজ এসেছে';
}

export function analyze({ from = '', subject = '', text = '', html = '' } = {}) {
  const plain = (text && text.trim()) || htmlToText(html);
  const service = detectService({ from, subject, text: plain });
  return {
    plain,
    service,
    otp: extractOtp(subject, plain),
    links: extractLinks(html, plain),
    purpose: detectPurpose(subject, plain),
    details: extractDetails(plain, subject),
  };
}
