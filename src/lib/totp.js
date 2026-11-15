import crypto from 'crypto';

const B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const VALID_ALGOS = new Set(['SHA1', 'SHA256', 'SHA512']);

const ISSUER_RULES = [
  [/google|gmail|accounts\.google/i, 'Google', 'Personal'],
  [/github/i, 'GitHub', 'Dev'],
  [/gitlab/i, 'GitLab', 'Dev'],
  [/discord/i, 'Discord', 'Social'],
  [/openai|chatgpt/i, 'OpenAI', 'AI'],
  [/anthropic|claude/i, 'Claude', 'AI'],
  [/binance|bybit|okx|coinbase|kraken|metamask/i, 'Crypto', 'Finance'],
  [/paypal|stripe|wise|payoneer|revolut/i, 'Finance', 'Finance'],
  [/telegram/i, 'Telegram', 'Social'],
  [/facebook|meta|instagram|whatsapp/i, 'Meta', 'Social'],
  [/microsoft|outlook|azure|live\.com/i, 'Microsoft', 'Work'],
  [/apple|icloud/i, 'Apple', 'Personal'],
  [/amazon|aws/i, 'Amazon', 'Shopping'],
  [/cloudflare|vercel|render|netlify|heroku|digitalocean/i, 'Cloud', 'Dev'],
  [/twitter|x\.com/i, 'X', 'Social'],
  [/proton/i, 'Proton', 'Personal'],
  [/steam|epicgames|riot|roblox/i, 'Gaming', 'Gaming'],
];

/** Infer normalized issuer brand and vault category from label/issuer text. */
export function detectIssuer(name = '', explicitIssuer = '') {
  const combined = `${explicitIssuer} ${name}`.trim();
  for (const [re, brand, category] of ISSUER_RULES) {
    if (re.test(combined)) {
      return { issuer: explicitIssuer.trim() || brand, category };
    }
  }
  return { issuer: explicitIssuer.trim() || '', category: 'General' };
}

/** Decode Base32 (or hex / otpauth URI secret) into raw key bytes. */
export function b32ToBytes(raw) {
  let s = String(raw || '').trim();
  if (s.startsWith('otpauth://')) {
    try {
      const u = new URL(s);
      s = u.searchParams.get('secret') || s;
    } catch {}
  }
  const clean = s.toUpperCase().replace(/[\s\-=]+/g, '');
  if (!clean) return Buffer.alloc(0);

  if (/^[A-Z2-7]+$/.test(clean)) {
    let bits = 0;
    let val = 0;
    const out = [];
    for (let i = 0; i < clean.length; i++) {
      val = (val << 5) | B32_ALPHA.indexOf(clean[i]);
      bits += 5;
      if (bits >= 8) {
        out.push((val >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return Buffer.from(out);
  }
  if (/^[0-9A-F]+$/i.test(clean) && clean.length % 2 === 0) {
    return Buffer.from(clean, 'hex');
  }
  const mapped = clean.replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B').replace(/[^A-Z2-7]/g, 'A');
  let bits = 0;
  let val = 0;
  const out = [];
  for (let i = 0; i < mapped.length; i++) {
    val = (val << 5) | B32_ALPHA.indexOf(mapped[i]);
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Encode raw bytes into canonical unpadded Base32 string. */
export function bytesToB32(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  let bits = 0;
  let val = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    val = (val << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHA[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHA[(val << (5 - bits)) & 31];
  return out;
}

/** Compute HOTP/TOTP code for a given counter step. */
export function totpAt(secret, counter, { algo = 'SHA1', digits = 6 } = {}) {
  const key = b32ToBytes(secret);
  const d = Number(digits) === 8 ? 8 : 6;
  if (!key.length) return '-'.repeat(d);
  const alg = VALID_ALGOS.has(String(algo).toUpperCase()) ? String(algo).toUpperCase() : 'SHA1';
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac(alg.toLowerCase(), key).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const mod = 10 ** d;
  const code = (((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % mod;
  return String(code).padStart(d, '0');
}

/** Compute live TOTP code, next code, and remaining seconds. */
export function computeTotp(secret, nowMs = Date.now(), opts = {}) {
  const period = Math.max(15, Math.min(120, Number(opts.period) || 30));
  const digits = Number(opts.digits) === 8 ? 8 : 6;
  const algo = VALID_ALGOS.has(String(opts.algo || '').toUpperCase()) ? String(opts.algo).toUpperCase() : 'SHA1';
  const sec = Math.floor(nowMs / 1000);
  const counter = Math.floor(sec / period);
  const remaining = period - (sec % period);
  return {
    code: totpAt(secret, counter, { algo, digits }),
    nextCode: totpAt(secret, counter + 1, { algo, digits }),
    remaining,
    period,
    digits,
    algo,
  };
}

/** Parse standard `otpauth://totp/...` URI into normalized vault entry fields. */
export function parseOtpAuthUri(raw = '', fallbackName = '') {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'otpauth:') return null;
    const pathLbl = decodeURIComponent(u.pathname.replace(/^\/+totp\/*/i, '')).trim();
    const issParam = (u.searchParams.get('issuer') || '').trim();
    const secret = (u.searchParams.get('secret') || '').toUpperCase().replace(/[\s\-=]+/g, '');
    if (!secret) return null;
    const rawAlgo = (u.searchParams.get('algorithm') || 'SHA1').toUpperCase();
    const algo = VALID_ALGOS.has(rawAlgo) ? rawAlgo : 'SHA1';
    const digits = Number(u.searchParams.get('digits')) === 8 ? 8 : 6;
    const period = Math.max(15, Math.min(120, Number(u.searchParams.get('period')) || 30));
    const displayName = fallbackName.trim()
      || (issParam && pathLbl && !pathLbl.toLowerCase().startsWith(issParam.toLowerCase()) ? `${issParam} (${pathLbl})` : (pathLbl || issParam || '2FA Account'));
    const meta = detectIssuer(displayName, issParam);
    return {
      name: displayName.slice(0, 60),
      secret,
      issuer: meta.issuer,
      category: meta.category,
      algo,
      digits,
      period,
    };
  } catch {
    return null;
  }
}

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result >>> 0, pos];
    shift += 7;
    if (shift > 35) break;
  }
  return [result >>> 0, pos];
}

function decodeOtpParams(buf) {
  let pos = 0;
  let secretBytes = null;
  let name = '';
  let issuer = '';
  let algoCode = 1;
  let digitsCode = 1;
  while (pos < buf.length) {
    const [tag, p1] = readVarint(buf, pos);
    pos = p1;
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 2) {
      const [len, p2] = readVarint(buf, pos);
      const end = Math.min(buf.length, p2 + len);
      const slice = buf.subarray(p2, end);
      pos = end;
      if (field === 1) secretBytes = slice;
      else if (field === 2) name = slice.toString('utf8');
      else if (field === 3) issuer = slice.toString('utf8');
    } else if (wire === 0) {
      const [val, p2] = readVarint(buf, pos);
      pos = p2;
      if (field === 4) algoCode = val;
      else if (field === 5) digitsCode = val;
    } else {
      break;
    }
  }
  if (!secretBytes || !secretBytes.length) return null;
  const secret = bytesToB32(secretBytes);
  const algoMap = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' };
  const algo = algoMap[algoCode] || 'SHA1';
  const digits = digitsCode === 2 ? 8 : 6;
  const label = issuer && name && !name.toLowerCase().startsWith(issuer.toLowerCase()) ? `${issuer} (${name})` : (name || issuer || '2FA Account');
  const meta = detectIssuer(label, issuer);
  return { name: label.slice(0, 60), secret, issuer: meta.issuer, category: meta.category, algo, digits, period: 30 };
}

/** Decode Google Authenticator `otpauth-migration://offline?data=...` batch export URIs. */
export function parseMigrationUri(raw = '') {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'otpauth-migration:') return [];
    const data = u.searchParams.get('data');
    if (!data) return [];
    const buf = Buffer.from(data.replace(/\s+/g, '+'), 'base64');
    const items = [];
    let pos = 0;
    while (pos < buf.length) {
      const [tag, p1] = readVarint(buf, pos);
      pos = p1;
      const field = tag >>> 3;
      const wire = tag & 7;
      if (wire === 2) {
        const [len, p2] = readVarint(buf, pos);
        const end = Math.min(buf.length, p2 + len);
        const slice = buf.subarray(p2, end);
        pos = end;
        if (field === 1) {
          const entry = decodeOtpParams(slice);
          if (entry) items.push(entry);
        }
      } else if (wire === 0) {
        const [, p2] = readVarint(buf, pos);
        pos = p2;
      } else {
        break;
      }
    }
    return items;
  } catch {
    return [];
  }
}

/** Clean a single user-supplied secret or otpauth URI into normalized entry metadata. */
export function cleanTotpInput(name = '', rawSecret = '') {
  const s = String(rawSecret || '').trim();
  if (s.startsWith('otpauth://')) {
    const parsed = parseOtpAuthUri(s, name);
    if (parsed) return parsed;
  }
  const secret = s.toUpperCase().replace(/[\s\-=]+/g, '');
  const label = String(name || '').trim() || '2FA Account';
  const meta = detectIssuer(label, '');
  return {
    name: label.slice(0, 60),
    secret,
    issuer: meta.issuer,
    category: meta.category,
    algo: 'SHA1',
    digits: 6,
    period: 30,
  };
}

/** Parse arbitrary pasted text (`otpauth-migration://`, `otpauth://`, bulk `name|secret`, or plain key). */
export function parseBulkTotpInput(raw = '', fallbackName = '') {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.startsWith('otpauth-migration://')) return parseMigrationUri(text);

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (line.startsWith('otpauth-migration://')) {
      out.push(...parseMigrationUri(line));
      continue;
    }
    if (line.startsWith('otpauth://')) {
      const p = parseOtpAuthUri(line, lines.length === 1 ? fallbackName : '');
      if (p) out.push(p);
      continue;
    }
    const sep = line.includes('|') ? '|' : (line.includes('\t') ? '\t' : (line.includes(':') ? ':' : ''));
    if (sep) {
      const parts = line.split(sep).map((x) => x.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const candidateSecret = parts[parts.length - 1].replace(/[\s\-=]+/g, '').toUpperCase();
        if (candidateSecret.length >= 4 && b32ToBytes(candidateSecret).length > 0) {
          const lbl = parts.slice(0, -1).join(' ');
          out.push(cleanTotpInput(lbl, candidateSecret));
          continue;
        }
      }
    }
    const clean = cleanTotpInput(lines.length === 1 ? fallbackName : '', line);
    if (clean.secret.length >= 4 && b32ToBytes(clean.secret).length > 0) out.push(clean);
  }
  return out;
}
