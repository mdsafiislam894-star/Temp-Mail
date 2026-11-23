import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tempmail-srv-'));
process.env.DATA_DIR = tmpDir;
process.env.TELEGRAM_BOT_TOKEN = 'test_bot_token_42';
process.env.TELEGRAM_CHAT_ID = '99001';
process.env.GOOGLE_CLIENT_ID = '';
process.env.GOOGLE_CLIENT_SECRET = '';
process.env.PUBLIC_URL = 'https://example.test';
process.env.OPEN_ACCESS = 'true';

const { config } = await import('../src/config.js');
const { startServer } = await import('../src/server.js');
const store = await import('../src/store.js');

function buildInitData(user, token = config.token) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify(user),
  });
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(check).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

let server;
let baseUrl;
const adminInit = buildInitData({ id: 99001, first_name: 'Ariyan', username: 'ariyan' });

test.before(() => new Promise((resolve) => {
  server = startServer(0);
  server.once('listening', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

test.after(() => new Promise((resolve) => {
  server.close(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resolve();
  });
}));

async function apiReq(p, opts = {}) {
  const res = await fetch(`${baseUrl}${p}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-init-data': opts.noAuth ? '' : adminInit,
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, body };
}

test('API enforces Telegram initData auth and bootstrap returns honest config & sseToken', async () => {
  const unauth = await apiReq('/api/bootstrap', { noAuth: true });
  assert.equal(unauth.status, 401);

  const boot = await apiReq('/api/bootstrap', { method: 'POST', body: '{}' });
  assert.equal(boot.status, 200);
  assert.ok(boot.body.sseToken);
  assert.equal(boot.body.gmailEnabled, false);
  assert.equal(boot.body.googleConfigured, false);
  assert.deepEqual(boot.body.domains, config.domains);
  assert.equal(boot.body.user.admin, true);
});

test('/api/events SSE stream authenticates via sseToken', async () => {
  const bad = await fetch(`${baseUrl}/api/events?token=invalid.sig`);
  assert.equal(bad.status, 401);

  const boot = await apiReq('/api/bootstrap', { method: 'POST', body: '{}' });
  const ac = new AbortController();
  const res = await fetch(`${baseUrl}/api/events?token=${encodeURIComponent(boot.body.sseToken)}`, { signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  assert.match(Buffer.from(value).toString(), /event: connected/);
  ac.abort();
});

test('/api/domain, /api/addresses pin/domain/ttl, /api/totp bulk, /api/backup, and /api/admin/sweep', async () => {
  const dom = await apiReq('/api/domain', { method: 'POST', body: JSON.stringify({ domain: 'mdsafiislam.tech' }) });
  assert.equal(dom.status, 200);
  assert.equal(dom.body.prefDomain, 1);

  const addr = await apiReq('/api/addresses', {
    method: 'POST',
    body: JSON.stringify({ name: 'testbox', domain: 'safix.tech', label: 'Primary', ttl: 10 }),
  });
  assert.equal(addr.status, 200);
  assert.equal(addr.body.address.addr, 'testbox@safix.tech');
  assert.ok(addr.body.address.expiresAt > Date.now());

  const pin = await apiReq('/api/addresses', {
    method: 'PATCH',
    body: JSON.stringify({ id: addr.body.address.id, pinned: true }),
  });
  assert.equal(pin.status, 200);

  const expRec = store.getAddress('testbox@safix.tech');
  expRec.expiresAt = Date.now() - 1000;
  const sweep = await apiReq('/api/admin/sweep', { method: 'POST', body: '{}' });
  assert.equal(sweep.status, 200);
  assert.equal(sweep.body.expired, 1);

  const imp = await apiReq('/api/totp', {
    method: 'POST',
    body: JSON.stringify({ raw: 'otpauth://totp/Cloudflare:ops@safix.tech?secret=JBSWY3DPEHPK3PXP&issuer=Cloudflare' }),
  });
  assert.equal(imp.status, 200);
  assert.ok(imp.body.items.some((x) => x.issuer === 'Cloudflare'));

  const bkp = await apiReq('/api/backup');
  assert.equal(bkp.status, 200);
  assert.ok(Array.isArray(bkp.body.backup.totp));
  assert.ok(bkp.body.backup.totp.length >= 1);
});

test('PATCH /api/addresses rename, PATCH /api/messages/:id note/unread, and PATCH /api/gmail label work end-to-end', async () => {
  const c1 = await apiReq('/api/addresses', { method: 'POST', body: JSON.stringify({ name: 'renbox1', domain: 'safix.tech', ttl: 60 }) });
  const c2 = await apiReq('/api/addresses', { method: 'POST', body: JSON.stringify({ name: 'renbox2', domain: 'safix.tech', ttl: 60 }) });
  assert.equal(c1.status, 200);
  assert.equal(c2.status, 200);
  const owner = store.getAddress(c1.body.address.addr).owner;

  store.addMessage({ id: 'srv_msg_1', owner, to: 'renbox1@safix.tech', from: 'bot@github.com', subject: 'Code 554433', date: Date.now(), read: true, otp: '554433' });

  const clash = await apiReq('/api/addresses', { method: 'PATCH', body: JSON.stringify({ id: c1.body.address.id, local: 'renbox2', domain: 'safix.tech' }) });
  assert.equal(clash.status, 409);

  const ren = await apiReq('/api/addresses', { method: 'PATCH', body: JSON.stringify({ id: c1.body.address.id, local: 'renamed99', domain: 'safix.tech', label: 'DevBox', ttl: 0, migrateMessages: true }) });
  assert.equal(ren.status, 200);
  assert.equal(ren.body.address.addr, 'renamed99@safix.tech');
  assert.equal(ren.body.address.label, 'DevBox');
  assert.equal(store.getMessage('srv_msg_1').to, 'renamed99@safix.tech');

  const msgUpd = await apiReq('/api/messages/srv_msg_1', { method: 'PATCH', body: JSON.stringify({ read: false, note: 'Keep for deploy', pinned: true }) });
  assert.equal(msgUpd.status, 200);
  assert.equal(msgUpd.body.message.read, false);
  assert.equal(msgUpd.body.message.note, 'Keep for deploy');
  assert.equal(msgUpd.body.message.pinned, true);

  store.upsertGmail({ owner, email: 'testuser99@gmail.com', mode: 'app_pass', password: 'abc' });
  const gmLbl = await apiReq('/api/gmail', { method: 'PATCH', body: JSON.stringify({ email: 'testuser99@gmail.com', label: 'Primary Mail' }) });
  assert.equal(gmLbl.status, 200);
  assert.equal(gmLbl.body.account.label, 'Primary Mail');
});

test('browser extension client authenticates via x-ext-id and CORS preflight succeeds', async () => {
  const extOpts = await fetch(`${baseUrl}/api/bootstrap`, { method: 'OPTIONS' });
  assert.equal(extOpts.status, 204);
  assert.equal(extOpts.headers.get('access-control-allow-origin'), '*');

  const extRes = await fetch(`${baseUrl}/api/bootstrap`, {
    headers: { 'x-ext-id': 'client_uuid_test_123' },
  });
  assert.equal(extRes.status, 200);
  const data = await extRes.json();
  assert.ok(data.user);
  assert.equal(data.user.id, 'ext_client_uuid_test_123');
  assert.ok(Array.isArray(data.domains));
  assert.ok(data.sseToken);

  const newMail = await fetch(`${baseUrl}/api/addresses`, {
    method: 'POST',
    headers: { 'x-ext-id': 'client_uuid_test_123', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'extbox', domain: 'safix.tech' }),
  });
  assert.equal(newMail.status, 200);
  const addrData = await newMail.json();
  assert.equal(addrData.address.addr, 'extbox@safix.tech');
});
