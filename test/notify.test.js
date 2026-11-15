import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import * as store from '../src/store.js';
import { subscribeUser, closeAllEvents } from '../src/events.js';
import { ingest } from '../src/notify.js';

function mockRes() {
  const em = new EventEmitter();
  let chunks = '';
  return {
    on: em.on.bind(em),
    once: em.once.bind(em),
    emit: em.emit.bind(em),
    writeHead() {},
    write(c) { chunks += String(c); return true; },
    end() { em.emit('close'); },
    get chunks() { return chunks; },
  };
}

test('ingest broadcasts real-time mail:new SSE event with OTP payload to owner', async () => {
  closeAllEvents();
  store.touchUser({ id: '77701', first_name: 'Stream' }, 'approved');
  const addr = store.generateUniqueAddress('77701', 'sseuser', '', 0, 'safix.tech');
  const res = mockRes();
  subscribeUser('77701', res);

  await ingest({
    to: addr.addr,
    from: 'Vercel <verify@vercel.com>',
    subject: 'Your login code is 492018',
    text: 'Enter code 492018 to continue.',
    messageId: `sse-${Date.now()}`,
    source: 'worker',
    silentNotify: true,
  });

  assert.match(res.chunks, /event: mail:new/);
  assert.match(res.chunks, /"otp":"492018"/);

  // Also ensure ingest with silentNotify: false degrades gracefully when botApi is not initialized
  const res2 = await ingest({
    to: addr.addr,
    from: 'OpenAI <noreply@openai.com>',
    subject: 'Code 731904',
    text: 'Your code is 731904',
    messageId: `sse2-${Date.now()}`,
    source: 'worker',
    silentNotify: false,
  });
  assert.equal(res2?.otp, '731904');
  closeAllEvents();
});
