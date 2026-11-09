import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.TELEGRAM_BOT_TOKEN = '123:TEST';
const { validateInitData, signToken, verifyToken } = await import('../src/auth.js');

const sign = (token, user, age = 0) => {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - age), user: JSON.stringify(user) });
  const c = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const sk = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', crypto.createHmac('sha256', sk).update(c).digest('hex'));
  return p.toString();
};

test('initData: valid', () => assert.equal(validateInitData(sign('123:TEST', { id: 5 }), '123:TEST').id, 5));
test('initData: wrong token', () => assert.equal(validateInitData(sign('999:X', { id: 5 }), '123:TEST'), null));
test('initData: tampered', () => assert.equal(validateInitData(sign('123:TEST', { id: 5 }).replace('%3A5', '%3A6'), '123:TEST'), null));
test('initData: expired', () => assert.equal(validateInitData(sign('123:TEST', { id: 5 }, 999999), '123:TEST'), null));
test('signed token roundtrip + tamper + expiry', () => {
  const t = signToken({ uid: '7' }, 60);
  assert.equal(verifyToken(t).uid, '7');
  assert.equal(verifyToken(t.slice(0, -2) + 'xx'), null);
  assert.equal(verifyToken(signToken({ uid: '7' }, -1)), null);
});
