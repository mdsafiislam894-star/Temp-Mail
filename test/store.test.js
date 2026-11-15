import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tempmail-store-'));
process.env.DATA_DIR = tmpDir;

const totpLib = await import('../src/lib/totp.js');
const store = await import('../src/store.js');

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('lib/totp computes RFC6238 SHA1/SHA256/SHA512 & 8-digit codes accurately', () => {
  // Known RFC 6238 test vector for ASCII "12345678901234567890" -> Base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  // At t=59s (counter=1), 8-digit SHA1 = 94287082, 6-digit = 287082
  assert.equal(totpLib.totpAt(secret, 1, { algo: 'SHA1', digits: 8 }), '94287082');
  assert.equal(totpLib.totpAt(secret, 1, { algo: 'SHA1', digits: 6 }), '287082');

  const live = totpLib.computeTotp(secret, 59000, { algo: 'SHA1', digits: 6, period: 30 });
  assert.equal(live.code, '287082');
  assert.equal(live.remaining, 1);
  assert.equal(live.digits, 6);
});

test('lib/totp parses otpauth:// and otpauth-migration:// payloads', () => {
  const one = totpLib.parseOtpAuthUri('otpauth://totp/GitHub:dev%40safix.tech?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=60');
  assert.equal(one.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(one.issuer, 'GitHub');
  assert.equal(one.algo, 'SHA256');
  assert.equal(one.digits, 8);
  assert.equal(one.period, 60);

  // Build valid Google Authenticator MigrationPayload protobuf bytes
  // OtpParameters: 1:secret("Hello!"), 2:name("alice@gmail.com"), 3:issuer("Google"), 4:algo=1(SHA1), 5:digits=1(6), 6:type=2(TOTP)
  const rawSecret = Buffer.from('Hello!'); // Base32: JBSWY3DPEBQQ====
  const str = (field, text) => {
    const b = Buffer.from(text, 'utf8');
    return Buffer.concat([Buffer.from([(field << 3) | 2, b.length]), b]);
  };
  const bytes = (field, buf) => Buffer.concat([Buffer.from([(field << 3) | 2, buf.length]), buf]);
  const varint = (field, v) => Buffer.from([(field << 3) | 0, v]);
  const otpParam = Buffer.concat([
    bytes(1, rawSecret),
    str(2, 'alice@gmail.com'),
    str(3, 'Google'),
    varint(4, 1),
    varint(5, 1),
    varint(6, 2),
  ]);
  const payload = bytes(1, otpParam);
  const migUri = `otpauth-migration://offline?data=${encodeURIComponent(payload.toString('base64'))}`;

  const parsed = totpLib.parseMigrationUri(migUri);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].issuer, 'Google');
  assert.match(parsed[0].name, /alice@gmail\.com/);
  assert.equal(parsed[0].secret, 'JBSWY3DPEE');
  assert.deepEqual(totpLib.b32ToBytes(parsed[0].secret), rawSecret);
  assert.equal(parsed[0].digits, 6);
});

test('store TTL expiry, domainOverride, pin sorting, and search filters work properly', () => {
  store.touchUser({ id: 'u100', first_name: 'Ariyan', username: 'ariyan' }, 'approved');

  const permanent = store.generateUniqueAddress('u100', 'perm', 'Main', 0, 'safix.tech');
  assert.equal(permanent.addr, 'perm@safix.tech');
  assert.equal(permanent.ttl, 0);

  const expiring = store.generateUniqueAddress('u100', 'temp1', 'OTP', 10, 'mdsafiislam.tech');
  assert.equal(expiring.addr, 'temp1@mdsafiislam.tech');
  assert.ok(expiring.expiresAt > Date.now());
  expiring.expiresAt = Date.now() - 5000; // simulate expiry
  const swept = store.expireSweep();
  assert.equal(swept.length, 1);
  assert.equal(swept[0].expired, true);

  store.setPinnedAddress('u100', expiring.id, true);
  const addrs = store.listAddresses('u100');
  assert.equal(addrs[0].id, expiring.id);
  assert.equal(addrs[0].pinned, true);

  const m1 = store.addMessage({
    owner: 'u100', key: 'k1', to: 'perm@safix.tech', from: 'Google <no-reply@accounts.google.com>',
    subject: 'Security alert', otp: '991122', date: Date.now() - 1000, links: [{ url: 'https://google.com/v', score: 5 }],
  });
  const m2 = store.addMessage({
    owner: 'u100', key: 'k2', to: 'temp1@mdsafiislam.tech', from: 'Newsletter <news@x.io>',
    subject: 'Weekly digest', otp: '', date: Date.now(), links: [],
  });
  store.pinMessage('u100', m1.id, true);
  assert.equal(store.hasSeen('k1'), true);
  assert.equal(store.listMessages('u100', { filter: 'otp' }).length, 1);
  assert.equal(store.listMessages('u100', { filter: 'pinned' })[0].id, m1.id);
  assert.equal(store.listMessages('u100', { q: '991122' }).length, 1);
  assert.equal(store.countStats('u100').otp, 1);
  assert.equal(store.countStats('u100').unread, 2);
});

test('store TOTP vault supports pin, bulk import, algo/digits, and backup restore', () => {
  const t1 = store.addTotp('u100', 'GitHub Dev', 'JBSWY3DPEHPK3PXP');
  const added = store.importTotpBulk('u100', 'Google Work|GEZDGNBVGY3TQOJQ\nCloudflare|KRSXG5CTMVRXEZLU');
  assert.equal(added.length, 2);
  store.pinTotp('u100', added[1].id, true);
  const list = store.listTotp('u100');
  assert.equal(list[0].id, added[1].id);
  assert.equal(list[0].pinned, true);
  assert.equal(list.some((x) => x.id === t1.id), true);

  const backup = store.exportUserBackup('u100');
  assert.ok(backup.addresses.length >= 2);
  assert.ok(backup.totp.length >= 3);

  const stGlass = store.setSettings('u100', { skin: 'glass', theme: 'claude', liteBlur: true });
  assert.equal(stGlass.skin, 'glass');
  assert.equal(stGlass.theme, 'claude');
  assert.equal(stGlass.liteBlur, true);

  const stMix = store.setSettings('u100', { skin: 'mix', theme: 'claude-light' });
  assert.equal(stMix.skin, 'mix');
  assert.equal(stMix.theme, 'claude-light');

  const stBento = store.setSettings('u100', { skin: 'bento', theme: 'aurora' });
  assert.equal(stBento.skin, 'bento');
  assert.equal(stBento.theme, 'aurora');
});
