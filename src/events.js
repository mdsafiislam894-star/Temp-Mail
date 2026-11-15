/** Per-user Server-Sent Events (SSE) broadcaster for sub-50ms real-time UI updates. */
const subscribers = new Map(); // uid -> Set<ServerResponse>
let heartbeatTimer = null;

function ensureHeartbeat() {
  if (heartbeatTimer || subscribers.size === 0) return;
  heartbeatTimer = setInterval(() => {
    for (const [uid, set] of subscribers) {
      for (const res of set) {
        try {
          res.write(': ping\n\n');
        } catch {
          set.delete(res);
        }
      }
      if (set.size === 0) subscribers.delete(uid);
    }
    if (subscribers.size === 0 && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }, 20000);
  heartbeatTimer.unref?.();
}

/** Attach an HTTP response as an SSE listener for a user ID. */
export function subscribeUser(uid, res) {
  const key = String(uid);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);

  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(res);
  ensureHeartbeat();

  const cleanup = () => {
    set.delete(res);
    if (set.size === 0) subscribers.delete(key);
    if (subscribers.size === 0 && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
  return cleanup;
}

/** Push a typed JSON event to all open Mini App tabs of a user. */
export function emitUserEvent(uid, event, payload = {}) {
  const set = subscribers.get(String(uid));
  if (!set || set.size === 0) return 0;
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  let sent = 0;
  for (const res of [...set]) {
    try {
      res.write(frame);
      sent++;
    } catch {
      set.delete(res);
    }
  }
  if (set.size === 0) subscribers.delete(String(uid));
  return sent;
}

/** Gracefully close all active SSE streams on server shutdown. */
export function closeAllEvents() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const set of subscribers.values()) {
    for (const res of [...set]) {
      try { res.end(); } catch {}
    }
  }
  subscribers.clear();
}

export function getEventStats() {
  let clients = 0;
  for (const set of subscribers.values()) clients += set.size;
  return { users: subscribers.size, clients };
}
