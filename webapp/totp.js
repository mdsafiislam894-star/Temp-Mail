/** Client-side WebCrypto RFC 6238 TOTP Engine, URI/Migration Parser, Brand Detector, and Encrypted Backup Helpers. */

const B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const VALID_ALGOS = new Set(['SHA1', 'SHA256', 'SHA512']);
const codeCache = new Map();

const BRAND_RULES = [
  [/google|gmail|accounts\.google/i, 'Google', 'GO', '#4285f4', 'Personal'],
  [/github/i, 'GitHub', 'GH', '#8b949e', 'Dev'],
  [/gitlab/i, 'GitLab', 'GL', '#fc6d26', 'Dev'],
  [/discord/i, 'Discord', 'DC', '#5865f2', 'Social'],
  [/openai|chatgpt/i, 'OpenAI', 'OA', '#10a37f', 'AI'],
  [/anthropic|claude/i, 'Claude', 'CL', '#d97757', 'AI'],
  [/binance|bybit|okx|coinbase|kraken|metamask/i, 'Crypto', 'CR', '#f0b90b', 'Finance'],
  [/paypal|stripe|wise|payoneer|revolut/i, 'Finance', 'FI', '#635bff', 'Finance'],
  [/telegram/i, 'Telegram', 'TG', '#2aabee', 'Social'],
  [/facebook|meta|instagram|whatsapp/i, 'Meta', 'MT', '#0866ff', 'Social'],
  [/microsoft|outlook|azure|live\.com/i, 'Microsoft', 'MS', '#00a4ef', 'Work'],
  [/apple|icloud/i, 'Apple', 'AP', '#a1a1aa', 'Personal'],
  [/amazon|aws/i, 'Amazon', 'AZ', '#ff9900', 'Shopping'],
  [/cloudflare|vercel|render|netlify|heroku|digitalocean/i, 'Cloud', 'CD', '#f38020', 'Dev'],
  [/twitter|x\.com/i, 'X', 'XX', '#94a3b8', 'Social'],
  [/proton/i, 'Proton', 'PR', '#6d4aff', 'Personal'],
  [/steam|epicgames|riot|roblox/i, 'Gaming', 'GM', '#38bdf8', 'Gaming'],
];

export function detectBrand(name = '', explicitIssuer = '') {
  const hay = `${explicitIssuer} ${name}`.trim();
  for (const [re, brand, mono, color, category] of BRAND_RULES) {
    if (re.test(hay)) {
      return { issuer: explicitIssuer.trim() || brand, mono, color, category };
    }
  }
  const clean = (explicitIssuer || name || '2FA').replace(/[^a-zA-Z0-9\s]/g, '').trim();
  const mono = clean.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '2F';
  return { issuer: explicitIssuer.trim() || '', mono: mono.slice(0, 2), color: '#6366f1', category: 'General' };
}

export function formatCode(code = '') {
  const s = String(code || '').trim();
  if (s.length === 6) return `${s.slice(0, 3)} ${s.slice(3)}`;
  if (s.length === 8) return `${s.slice(0, 4)} ${s.slice(4)}`;
  return s;
}

export function b32ToBytes(raw) {
  let s = String(raw || '').trim();
  if (s.startsWith('otpauth://')) {
    try { s = new URL(s).searchParams.get('secret') || s; } catch {}
  }
  const clean = s.toUpperCase().replace(/[\s\-=]+/g, '');
  if (!clean) return new Uint8Array(0);
  if (/^[A-Z2-7]+$/.test(clean)) {
    let bits = 0, val = 0;
    const out = [];
    for (let i = 0; i < clean.length; i++) {
      val = (val << 5) | B32_ALPHA.indexOf(clean[i]);
      bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(out);
  }
  if (/^[0-9A-F]+$/i.test(clean) && clean.length % 2 === 0) {
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const mapped = clean.replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B').replace(/[^A-Z2-7]/g, 'A');
  let bits = 0, val = 0;
  const out = [];
  for (let i = 0; i < mapped.length; i++) {
    val = (val << 5) | B32_ALPHA.indexOf(mapped[i]);
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export function bytesToB32(bytes) {
  let bits = 0, val = 0, out = '';
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

const SUBTLE_HASH = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

async function totpAtWebCrypto(secret, counter, { algo = 'SHA1', digits = 6 } = {}) {
  const alg = VALID_ALGOS.has(String(algo).toUpperCase()) ? String(algo).toUpperCase() : 'SHA1';
  const d = Number(digits) === 8 ? 8 : 6;
  const cacheKey = `${secret}:${alg}:${d}:${counter}`;
  if (codeCache.has(cacheKey)) return codeCache.get(cacheKey);

  const keyBytes = b32ToBytes(secret);
  if (!keyBytes.length || !globalThis.crypto?.subtle) return '-'.repeat(d);

  const msg = new Uint8Array(8);
  const view = new DataView(msg.buffer);
  view.setUint32(0, Math.floor(counter / 0x100000000), false);
  view.setUint32(4, counter >>> 0, false);

  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: { name: SUBTLE_HASH[alg] } },
    false,
    ['sign']
  );
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, msg));
  const off = sig[sig.length - 1] & 0x0f;
  const code = (((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3]) % (10 ** d);
  const res = String(code).padStart(d, '0');
  if (codeCache.size > 400) codeCache.clear();
  codeCache.set(cacheKey, res);
  return res;
}

export async function computeTotpAsync(secret, nowMs = Date.now(), opts = {}) {
  const period = Math.max(15, Math.min(120, Number(opts.period) || 30));
  const digits = Number(opts.digits) === 8 ? 8 : 6;
  const algo = VALID_ALGOS.has(String(opts.algo || '').toUpperCase()) ? String(opts.algo).toUpperCase() : 'SHA1';
  const sec = nowMs / 1000;
  const counter = Math.floor(sec / period);
  const remainingExact = period - (sec % period);
  const remaining = Math.max(1, Math.ceil(remainingExact));
  const [code, nextCode] = await Promise.all([
    totpAtWebCrypto(secret, counter, { algo, digits }),
    totpAtWebCrypto(secret, counter + 1, { algo, digits }),
  ]);
  return { code, nextCode, remaining, remainingExact, period, digits, algo };
}

export function getCachedTotpSync(secret, nowMs = Date.now(), opts = {}) {
  const period = Math.max(15, Math.min(120, Number(opts.period) || 30));
  const digits = Number(opts.digits) === 8 ? 8 : 6;
  const algo = VALID_ALGOS.has(String(opts.algo || '').toUpperCase()) ? String(opts.algo).toUpperCase() : 'SHA1';
  const sec = nowMs / 1000;
  const counter = Math.floor(sec / period);
  const remainingExact = period - (sec % period);
  const remaining = Math.max(1, Math.ceil(remainingExact));
  const k1 = `${secret}:${algo}:${digits}:${counter}`;
  const k2 = `${secret}:${algo}:${digits}:${counter + 1}`;
  return {
    code: codeCache.get(k1) || null,
    nextCode: codeCache.get(k2) || null,
    remaining,
    remainingExact,
    period,
    digits,
    algo,
  };
}

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
    const brand = detectBrand(displayName, issParam);
    return { name: displayName.slice(0, 60), secret, issuer: brand.issuer, category: brand.category, algo, digits, period };
  } catch {
    return null;
  }
}

function readVarint(bytes, offset) {
  let result = 0, shift = 0, pos = offset;
  while (pos < bytes.length) {
    const b = bytes[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result >>> 0, pos];
    shift += 7;
    if (shift > 35) break;
  }
  return [result >>> 0, pos];
}

export function parseMigrationUri(raw = '') {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'otpauth-migration:') return [];
    const data = u.searchParams.get('data');
    if (!data) return [];
    const b64 = data.replace(/\s+/g, '+').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const dec = new TextDecoder();
    const items = [];
    let pos = 0;
    while (pos < buf.length) {
      const [tag, p1] = readVarint(buf, pos); pos = p1;
      const field = tag >>> 3;
      const wire = tag & 7;
      if (wire === 2) {
        const [len, p2] = readVarint(buf, pos);
        const end = Math.min(buf.length, p2 + len);
        const sub = buf.subarray(p2, end);
        pos = end;
        if (field === 1) {
          let sp = 0, secretBytes = null, name = '', issuer = '', algoC = 1, digC = 1;
          while (sp < sub.length) {
            const [st, s1] = readVarint(sub, sp); sp = s1;
            const sf = st >>> 3; const sw = st & 7;
            if (sw === 2) {
              const [sl, s2] = readVarint(sub, sp);
              const se = Math.min(sub.length, s2 + sl);
              const slice = sub.subarray(s2, se); sp = se;
              if (sf === 1) secretBytes = slice;
              else if (sf === 2) name = dec.decode(slice);
              else if (sf === 3) issuer = dec.decode(slice);
            } else if (sw === 0) {
              const [sv, s2] = readVarint(sub, sp); sp = s2;
              if (sf === 4) algoC = sv;
              else if (sf === 5) digC = sv;
            } else break;
          }
          if (secretBytes?.length) {
            const secret = bytesToB32(secretBytes);
            const algo = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' }[algoC] || 'SHA1';
            const digits = digC === 2 ? 8 : 6;
            const label = issuer && name && !name.toLowerCase().startsWith(issuer.toLowerCase()) ? `${issuer} (${name})` : (name || issuer || '2FA Account');
            const brand = detectBrand(label, issuer);
            items.push({ name: label.slice(0, 60), secret, issuer: brand.issuer, category: brand.category, algo, digits, period: 30 });
          }
        }
      } else if (wire === 0) {
        const [, p2] = readVarint(buf, pos); pos = p2;
      } else break;
    }
    return items;
  } catch {
    return [];
  }
}

export function parseBulkInput(raw = '', fallbackName = '') {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.startsWith('otpauth-migration://')) return parseMigrationUri(text);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (line.startsWith('otpauth-migration://')) { out.push(...parseMigrationUri(line)); continue; }
    if (line.startsWith('otpauth://')) { const p = parseOtpAuthUri(line, lines.length === 1 ? fallbackName : ''); if (p) out.push(p); continue; }
    const sep = line.includes('|') ? '|' : (line.includes('\t') ? '\t' : (line.includes(':') ? ':' : ''));
    if (sep) {
      const parts = line.split(sep).map((x) => x.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const cand = parts[parts.length - 1].replace(/[\s\-=]+/g, '').toUpperCase();
        if (cand.length >= 4 && b32ToBytes(cand).length > 0) {
          const nm = parts.slice(0, -1).join(' ');
          const brand = detectBrand(nm);
          out.push({ name: nm.slice(0, 60), secret: cand, issuer: brand.issuer, category: brand.category, algo: 'SHA1', digits: 6, period: 30 });
          continue;
        }
      }
    }
    const clean = line.toUpperCase().replace(/[\s\-=]+/g, '');
    if (clean.length >= 4 && b32ToBytes(clean).length > 0) {
      const nm = (lines.length === 1 && fallbackName.trim()) || '2FA Account';
      const brand = detectBrand(nm);
      out.push({ name: nm.slice(0, 60), secret: clean, issuer: brand.issuer, category: brand.category, algo: 'SHA1', digits: 6, period: 30 });
    }
  }
  return out;
}

export function buildOtpAuthUri(item) {
  const label = encodeURIComponent(item.issuer ? `${item.issuer}:${item.name}` : item.name);
  const qs = new URLSearchParams({
    secret: item.secret,
    ...(item.issuer ? { issuer: item.issuer } : {}),
    algorithm: item.algo || 'SHA1',
    digits: String(item.digits || 6),
    period: String(item.period || 30),
  });
  return `otpauth://totp/${label}?${qs.toString()}`;
}

async function deriveAesKey(passphrase, salt, usage) {
  const enc = new TextEncoder();
  const base = await globalThis.crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  );
}

const b64u = (u8) => btoa(String.fromCharCode(...u8));
const unb64u = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptBackup(dataObj, passphrase) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt, 'encrypt');
  const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(dataObj))
  ));
  return JSON.stringify({ encrypted: true, alg: 'AES-256-GCM', salt: b64u(salt), iv: b64u(iv), data: b64u(ct) }, null, 2);
}

export async function decryptBackup(rawJson, passphrase) {
  const pkg = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  if (!pkg?.encrypted) return pkg;
  const key = await deriveAesKey(passphrase, unb64u(pkg.salt), 'decrypt');
  const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(pkg.iv) }, key, unb64u(pkg.data));
  return JSON.parse(new TextDecoder().decode(pt));
}
