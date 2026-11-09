import crypto from 'crypto';
import { config } from './config.js';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

/** Validate Telegram Mini App initData. Returns the user object or null. */
export function validateInitData(initData, token = config.token, maxAgeSec = 86400) {
  if (!initData || !token) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const expected = hmac(hmac('WebAppData', token), check);
  let given;
  try { given = Buffer.from(hash, 'hex'); } catch { return null; }
  if (!safeEq(expected, given)) return null;
  const age = Math.floor(Date.now() / 1000) - Number(params.get('auth_date') || 0);
  if (!(age >= 0 && age <= maxAgeSec)) return null;
  try { return JSON.parse(params.get('user') || 'null'); } catch { return null; }
}

const secret = () => hmac('sign-v1', config.token || 'dev');

/** Short signed token (used for the Google OAuth `state`). */
export function signToken(payload, ttlSec = 600) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  const sig = hmac(secret(), body).toString('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token = '') {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  if (!safeEq(hmac(secret(), body), Buffer.from(sig, 'base64url'))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    return data.exp > Date.now() / 1000 ? data : null;
  } catch { return null; }
}
