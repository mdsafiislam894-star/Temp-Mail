import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from './config.js';
import { ingest } from './notify.js';
import * as store from './store.js';

const status = new Map();
const activeListeners = new Set();
const initialSynced = new Set();
export const titanStatus = () => ({
  total: config.titan.accounts.length,
  online: [...status.values()].filter(Boolean).length,
});
export const titanAccounts = () => config.titan.accounts.map((a) => ({ user: a.user, online: Boolean(status.get(a.user)) }));

function pickRecipient(parsed, fallback) {
  const list = []
    .concat(parsed.to || [], parsed.cc || [], parsed.bcc || [], parsed.deliveredTo || [])
    .flatMap((t) => (Array.isArray(t?.value) ? t.value : typeof t === 'string' ? [{ address: t }] : []))
    .map((v) => (v.address || '').toLowerCase())
    .filter(Boolean);
  const h = (name) => {
    const v = parsed.headers?.get(name);
    if (!v) return '';
    if (typeof v === 'string') return v.toLowerCase();
    if (v.text) return String(v.text).toLowerCase();
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ').toLowerCase();
    return '';
  };
  for (const k of ['delivered-to', 'x-original-to', 'envelope-to', 'x-envelope-to', 'x-forwarded-to', 'to', 'cc']) {
    const v = h(k);
    if (v) list.push(...(v.match(/[a-z0-9._+-]+@[a-z0-9.-]+/gi) || []).map((x) => x.toLowerCase()));
  }
  const rcv = parsed.headers?.get('received');
  const rcvList = Array.isArray(rcv) ? rcv : rcv ? [rcv] : [];
  for (const r of rcvList) {
    const s = typeof r === 'string' ? r : r?.text || '';
    const m = s.match(/for\s+<([a-z0-9._+-]+@[a-z0-9.-]+)>/i) || s.match(/for\s+([a-z0-9._+-]+@[a-z0-9.-]+)/i);
    if (m) list.push(m[1].toLowerCase());
  }
  const known = list.find((a) => store.getAddress(a));
  if (known) return known;
  const nonCatchAll = list.find((a) => a !== String(fallback || '').toLowerCase() && config.domains.some((d) => a.endsWith(`@${d}`)));
  if (nonCatchAll) return nonCatchAll;
  const mine = list.find((a) => config.domains.some((d) => a.endsWith(`@${d}`)));
  return mine || list[0] || fallback;
}

const failures = new Map();

async function drain(client, account, isFirstRun = false) {
  const lock = await client.getMailboxLock('INBOX');
  try {
    const sinceDate = new Date(Date.now() - 2 * 86400000);
    const [unseenUids, recentUids] = await Promise.all([
      client.search({ seen: false }, { uid: true }).catch(() => []),
      client.search({ since: sinceDate }, { uid: true }).catch(() => []),
    ]);
    const combined = [...new Set([...(recentUids || []).slice(-20), ...(unseenUids || []).slice(-20)])].sort((a, b) => a - b);
    const unseenSet = new Set(unseenUids || []);
    const todo = combined.filter((u) => !store.hasSeen(`uid:${account.user}:${u}`)).slice(-20);
    if (!todo.length) return;
    for (const uid of todo) {
      const fkey = `${account.user}:${uid}`;
      const uidKey = `uid:${account.user}:${uid}`;
      try {
        const msg = await client.fetchOne(uid, { source: true, flags: true }, { uid: true });
        if (msg?.source) {
          const p = await simpleParser(msg.source);
          const wasUnseen = unseenSet.has(uid) || !(msg.flags && msg.flags.has('\\Seen'));
          await ingest({
            to: account.host === 'imap.gmail.com' ? account.user : pickRecipient(p, account.user),
            owner: account.owner,
            from: p.from?.text || 'Unknown',
            subject: p.subject || '',
            text: p.text || '',
            html: typeof p.html === 'string' ? p.html : '',
            messageId: `${account.user}|${uid}|${p.messageId || ''}`,
            date: p.date ? p.date.getTime() : Date.now(),
            source: account.host === 'imap.gmail.com' ? 'gmail' : 'imap',
            silentNotify: isFirstRun && !wasUnseen,
          });
          store.markSeen(uidKey);
        }
        failures.delete(fkey);
      } catch (e) {
        const n = (failures.get(fkey) || 0) + 1;
        failures.set(fkey, n);
        if (n < 3) continue;
        store.markSeen(uidKey);
      }
      await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }).catch(() => {});
    }
  } finally {
    lock.release();
  }
}

export function startSingleImap(account) {
  const key = account.user.toLowerCase();
  if (activeListeners.has(key)) return;
  activeListeners.add(key);
  let attempt = 0;
  const run = async () => {
    const client = new ImapFlow({
      host: account.host || config.titan.host, port: 993, secure: true,
      auth: { user: account.user, pass: account.pass }, logger: false,
    });
    let busy = false, again = false, closed = false, fails = 0, poll;
    const processMail = async () => {
      if (busy) { again = true; return; }
      busy = true;
      try {
        do {
          again = false;
          const first = !initialSynced.has(key);
          await drain(client, account, first);
          initialSynced.add(key);
          fails = 0;
        } while (again);
      } catch (e) {
        if (++fails >= 3) { try { client.close(); } catch {} }
      } finally { busy = false; }
    };
    const onClose = () => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      status.set(account.user, false);
      const wait = Math.min(30000, 2500 * 2 ** Math.min(attempt++, 4));
      setTimeout(run, wait);
    };
    client.on('error', () => {});
    client.on('close', onClose);
    client.on('exists', () => processMail());
    try {
      await client.connect();
      status.set(account.user, true);
      attempt = 0;
      console.log(`✅ [IMAP Online] ${account.user}`);
      await processMail();
      poll = setInterval(processMail, 4000);
    } catch (e) {
      try { client.close(); } catch {}
      onClose();
    }
  };
  return run();
}

export function startTitan() {
  for (const g of store.allGmail()) {
    if (g.imapPass && g.status !== 'expired') {
      startSingleImap({ user: g.email, pass: g.imapPass, host: 'imap.gmail.com', owner: g.owner });
    }
  }
  const accounts = config.titan.accounts;
  if (!accounts.length) return;
  accounts.forEach((a) => startSingleImap(a));
}
