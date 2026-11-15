import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { config, parseDomains, parseTitanAccounts, webappUrl } from '../src/config.js';

test('parseDomains normalizes, deduplicates, and defaults safely', () => {
  assert.deepEqual(parseDomains(''), ['safix.tech', 'mdsafiislam.tech']);
  assert.deepEqual(parseDomains(' Example.COM , @Foo.bar , example.com '), ['example.com', 'foo.bar']);
});

test('parseTitanAccounts reads pairs without injecting hardcoded personal passwords', () => {
  const empty = parseTitanAccounts({});
  assert.deepEqual(empty, []);
  const single = parseTitanAccounts({ TITAN_EMAIL: 'a@x.com', TITAN_PASSWORD: 'p1' });
  assert.deepEqual(single, [{ user: 'a@x.com', pass: 'p1' }]);
  const multi = parseTitanAccounts({ TITAN_ACCOUNTS: 'a@x.com:p:1, b@y.com:p2' });
  assert.deepEqual(multi, [{ user: 'a@x.com', pass: 'p:1' }, { user: 'b@y.com', pass: 'p2' }]);
});

test('config.js contains no hardcoded passwords or disk-mutating runtime patches', () => {
  const raw = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.equal(raw.includes('fromCharCode'), false);
  assert.equal(raw.includes('V18_PATCH'), false);
  assert.equal(raw.includes('ServerResponse.prototype.end'), false);
  assert.ok(Array.isArray(config.domains) && config.domains.length >= 1);
  assert.equal(typeof webappUrl(), 'string');
});
