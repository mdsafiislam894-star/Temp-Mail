import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { subscribeUser, emitUserEvent, closeAllEvents, getEventStats } from '../src/events.js';

function mockSseRes() {
  const em = new EventEmitter();
  let chunks = '';
  let ended = false;
  let head = null;
  return {
    on: em.on.bind(em),
    once: em.once.bind(em),
    emit: em.emit.bind(em),
    writeHead(code, headers) { head = { code, headers }; },
    write(chunk) { if (!ended) chunks += String(chunk); return true; },
    end() { ended = true; em.emit('close'); },
    get chunks() { return chunks; },
    get ended() { return ended; },
    get head() { return head; },
  };
}

test('events SSE subscribes by user, scopes emits, and cleans up on close', () => {
  closeAllEvents();
  const r1 = mockSseRes();
  const r2 = mockSseRes();
  subscribeUser('u1', r1);
  subscribeUser('u2', r2);

  assert.equal(r1.head.code, 200);
  assert.match(r1.head.headers['Content-Type'], /text\/event-stream/);
  assert.equal(getEventStats().clients, 2);

  emitUserEvent('u1', 'mail:new', { id: 'm1', otp: '654321' });
  assert.match(r1.chunks, /event: mail:new/);
  assert.match(r1.chunks, /"otp":"654321"/);
  assert.equal(r2.chunks.includes('m1'), false);

  r1.end();
  assert.equal(getEventStats().clients, 1);
  closeAllEvents();
  assert.equal(getEventStats().clients, 0);
});
