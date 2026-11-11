import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.js';
import {
  startAuto2faJob,
  extractSecretFromText,
  formatSecretSpaced,
} from '../src/auto2faEngine.js';

test('extractSecretFromText parses otpauth URI, spaced Base32, and compact Base32', () => {
  assert.equal(
    extractSecretFromText('otpauth://totp/Google:test@gmail.com?secret=JBSWY3DPEHPK3PXP&issuer=Google'),
    'JBSWY3DPEHPK3PXP',
  );
  assert.equal(
    extractSecretFromText('v3jz 6twh hf4w 7pey kbox fi7i fmtp 2oac'),
    'V3JZ6TWHHF4W7PEYKBOXFI7IFMTP2OAC',
  );
  assert.equal(
    formatSecretSpaced('V3JZ6TWHHF4W7PEY'),
    'v3jz 6twh hf4w 7pey',
  );
});

test('startAuto2faJob direct secret key shortcut saves to vault and computes 6-digit TOTP', async () => {
  const uid = '888001';
  const r = await startAuto2faJob({
    uid,
    email: 'direct2fa@gmail.com',
    secretOrCode: 'v3jz 6twh hf4w 7pey kbox fi7i fmtp 2oac',
  });
  assert.equal(r.ok, true);
  assert.equal(r.job.status, 'completed');
  assert.equal(r.job.secret, 'V3JZ6TWHHF4W7PEYKBOXFI7IFMTP2OAC');
  assert.match(r.job.totpCode, /^\d{6}$/);
  const list = store.listTotp(uid);
  assert.ok(list.some((x) => x.secret === 'V3JZ6TWHHF4W7PEYKBOXFI7IFMTP2OAC'));
});
