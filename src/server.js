import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { config, webappUrl, gmailEnabled, setGoogleCreds } from './config.js';
import * as store from './store.js';
import { validateInitData, signToken, verifyToken } from './auth.js';
import { ingest, safeSend } from './notify.js';
import { gmailAuthUrl, handleOAuthCallback, startGmailPoller, pollNow, clearGmailTokenCache } from './gmail.js';
import { titanStatus, titanAccounts, startSingleImap } from './titan.js';
import { escapeHtml as esc } from './lib/mailparse.js';
import { mainLink } from './ui.js';
import { startAuto2faJob, performAuto2faAction, getJob, getActiveJobForUser, serializeJob } from './auto2faEngine.js';
import { subscribeUser, emitUserEvent, closeAllEvents, getEventStats } from './events.js';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'webapp');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

let botUsername = '';
const savedGc = store.getMeta('googleCreds');
if (savedGc) setGoogleCreds(savedGc.id, savedGc.secret);
export const setBotUsername = (u) => { botUsername = u; };

function sendPayload(req, res, code, headers, buf) {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  const ae = String(req?.headers?.['accept-encoding'] || '');
  if (raw.length >= 1024 && ae.includes('gzip')) {
    const gz = zlib.gzipSync(raw);
    res.writeHead(code, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    return res.end(gz);
  }
  res.writeHead(code, headers);
  return res.end(raw);
}

const json = (res, code, obj, req = null) =>
  sendPayload(req, res, code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  }, JSON.stringify(obj));

const readBody = (req, limit = 1500000) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });

const summary = (m) => ({
  id: m.id,
  to: m.to,
  from: m.from,
  subject: m.subject,
  service: m.service,
  purpose: m.purpose,
  otp: m.otp,
  date: m.date,
  read: Boolean(m.read),
  pinned: Boolean(m.pinned),
  note: m.note || '',
  source: m.source,
  links: m.links || [],
  linkCount: (m.links || []).length,
  firstLink: mainLink(m) ? { url: mainLink(m).url, label: mainLink(m).label || mainLink(m).host } : null,
});

const cleanName = (s = '') => s.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
const safeEq = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

async function inbound(req, res) {
  const auth = req.headers.authorization || '';
  if (!config.inboundSecret || !safeEq(auth, `Bearer ${config.inboundSecret}`)) {
    return json(res, 401, { error: 'unauthorized' }, req);
  }
  const b = await readBody(req, 6000000);
  if (!b.to) return json(res, 400, { error: 'missing to' }, req);
  const msg = await ingest({ ...b, source: 'worker' });
  return json(res, 200, { ok: true, id: msg?.id || null }, req);
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[1] === 'inbound' && req.method === 'POST') return inbound(req, res);

  if (parts[1] === 'events' && req.method === 'GET') {
    const tok = verifyToken(url.searchParams.get('token') || '');
    if (!tok || !tok.sse || !tok.uid) return json(res, 401, { error: 'unauthorized' }, req);
    const user = store.getUser(tok.uid);
    if (!user || user.status !== 'approved') return json(res, 403, { error: 'not_approved' }, req);
    subscribeUser(user.id, res);
    return;
  }

  let tg = validateInitData(req.headers['x-init-data']);
  if (!tg && (req.headers['x-ext-id'] || req.headers['x-api-key'])) {
    const rawExt = String(req.headers['x-ext-id'] || req.headers['x-api-key']).trim();
    const cleanId = rawExt.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (cleanId.length >= 6) {
      tg = { id: `ext_${cleanId}`, first_name: 'Extension User', username: 'browser_ext' };
    }
  }
  if (!tg) return json(res, 401, { error: 'unauthorized' }, req);
  const admin = String(tg.id) === config.adminId;
  if (!store.getUser(tg.id) && (admin || config.openAccess || String(tg.id).startsWith('ext_'))) {
    store.touchUser(tg, 'approved');
  }
  const user = store.getUser(tg.id);
  if (!user || user.status !== 'approved') return json(res, 403, { error: 'not_approved' }, req);

  const uid = user.id;
  const [, res1, id] = parts;
  const m = req.method;

  if (res1 === 'bootstrap' && (m === 'GET' || m === 'POST')) {
    const body = m === 'POST' ? await readBody(req).catch(() => ({})) : {};
    if (admin && body.restoreGoogle) {
      try {
        const gc = typeof body.restoreGoogle === 'string' ? JSON.parse(body.restoreGoogle) : body.restoreGoogle;
        if (gc?.id && gc?.secret) {
          setGoogleCreds(gc.id, gc.secret);
          store.setMeta('googleCreds', { id: config.google.clientId, secret: config.google.clientSecret });
        }
      } catch {}
    }
    const restore = body.restoreAddrs || url.searchParams.get('restore') || '';
    if (restore) {
      const list = Array.isArray(restore)
        ? restore
        : String(restore).split(',').map((s) => s.trim()).filter(Boolean);
      for (const item of list.slice(0, 60)) {
        const addr = typeof item === 'string' ? item.toLowerCase() : String(item?.addr || '').toLowerCase();
        const domain = addr.split('@')[1] || '';
        if (addr && config.domains.includes(domain)) {
          const rec = store.ensureAddress(uid, addr, item?.label || '', item?.ttl || 0);
          if (rec && item?.pinned) store.setPinnedAddress(uid, rec.id, true);
        }
      }
    }
    const restoreTotp = body.restoreTotp || url.searchParams.get('restoreTotp') || '';
    if (restoreTotp) {
      try {
        const arr = typeof restoreTotp === 'string' ? JSON.parse(restoreTotp) : restoreTotp;
        if (Array.isArray(arr)) store.importTotpBulk(uid, arr);
      } catch {}
    }
    if (body.restoreGmails) {
      try {
        const arr = typeof body.restoreGmails === 'string' ? JSON.parse(body.restoreGmails) : body.restoreGmails;
        if (Array.isArray(arr)) {
          let addedOAuth = false;
          for (const g of arr) {
            if (!g || !g.email || store.allGmail().some((x) => x.email === g.email)) continue;
            store.upsertGmail({
              email: g.email, owner: uid, refreshToken: g.refreshToken || '', imapPass: g.imapPass || '',
              clientId: g.clientId || '', clientSecret: g.clientSecret || '', status: g.status || 'active',
              connectedAt: g.connectedAt || Date.now(),
            });
            if (g.imapPass) startSingleImap({ user: g.email, pass: g.imapPass, host: 'imap.gmail.com', owner: uid });
            if (g.refreshToken) addedOAuth = true;
          }
          if (addedOAuth) startGmailPoller();
        }
      } catch {}
    }

    return json(res, 200, {
      user: { id: uid, name: user.name, username: user.username, admin },
      domains: config.domains,
      prefDomain: typeof user.prefDomain === 'number' ? user.prefDomain : -1,
      gmailEnabled: gmailEnabled(),
      googleConfigured: gmailEnabled(),
      brand: config.brand,
      unread: store.countUnread(uid),
      stats: store.countStats(uid),
      bot: botUsername,
      tz: config.tz,
      settings: store.getSettings(uid),
      totp: store.listTotp(uid),
      gmailVault: store.listGmail(uid).map((g) => ({
        email: g.email, label: g.label || '', status: g.status, lastError: g.lastError || '', connectedAt: g.connectedAt,
        hasRefresh: Boolean(g.refreshToken), hasImap: Boolean(g.imapPass), twoFaEnabled: Boolean(g.twoFaEnabled),
      })),
      activeAuto2fa: serializeJob(getActiveJobForUser(uid)),
      sseToken: signToken({ uid, sse: true }, 86400),
    }, req);
  }

  if (res1 === 'domain' && m === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    let idx = typeof b.prefDomain === 'number' ? b.prefDomain : Number(b.prefDomain);
    if (b.domain !== undefined) {
      const d = String(b.domain).trim().toLowerCase();
      idx = d === 'random' ? -1 : config.domains.indexOf(d);
      if (d !== 'random' && idx < 0) return json(res, 400, { error: 'অবৈধ ডোমেইন' }, req);
    }
    if (!Number.isInteger(idx) || idx < -1 || idx >= config.domains.length) idx = -1;
    store.setPrefDomain(uid, idx);
    emitUserEvent(uid, 'domain:changed', { prefDomain: idx });
    return json(res, 200, { ok: true, prefDomain: idx, domain: idx >= 0 ? config.domains[idx] : 'random' }, req);
  }

  if (res1 === 'totp') {
    if (m === 'GET' && id === 'export') {
      return json(res, 200, { items: store.exportTotp(uid), exportedAt: Date.now() }, req);
    }
    if (m === 'GET') {
      return json(res, 200, { items: store.listTotp(uid), serverTime: Date.now() }, req);
    }
    if (m === 'POST') {
      const b = await readBody(req);
      if (b.raw || b.bulk !== undefined) {
        const added = store.importTotpBulk(uid, b.raw ?? b.bulk, b.name || '');
        if (!added.length) return json(res, 400, { error: 'কোনো সঠিক 2FA Secret বা URI পাওয়া যায়নি' }, req);
        emitUserEvent(uid, 'totp:changed', { count: added.length });
        return json(res, 200, { ok: true, addedCount: added.length, item: added[0], items: store.listTotp(uid) }, req);
      }
      const item = store.addTotp(uid, b.name, b.secret, b.id || '', {
        issuer: b.issuer, category: b.category, algo: b.algo, digits: b.digits, period: b.period, pinned: b.pinned,
      });
      if (!item) return json(res, 400, { error: 'সঠিক 2FA Secret কোড বা otpauth URI দিন' }, req);
      emitUserEvent(uid, 'totp:changed', { id: item.id });
      return json(res, 200, { item, items: store.listTotp(uid) }, req);
    }
    if (m === 'PATCH') {
      const b = await readBody(req);
      const item = store.updateTotp(uid, b.id || id, {
        name: b.name, secret: b.secret, issuer: b.issuer, category: b.category,
        algo: b.algo, digits: b.digits, period: b.period, pinned: b.pinned,
      });
      if (!item && b.secret) {
        const created = store.addTotp(uid, b.name, b.secret, b.id || '', {
          issuer: b.issuer, category: b.category, algo: b.algo, digits: b.digits, period: b.period, pinned: b.pinned,
        });
        return json(res, 200, { item: created, items: store.listTotp(uid) }, req);
      }
      if (!item) return json(res, 404, { error: 'not_found' }, req);
      emitUserEvent(uid, 'totp:changed', { id: item.id });
      return json(res, 200, { item, items: store.listTotp(uid) }, req);
    }
    if (m === 'DELETE') {
      const targetId = id || url.searchParams.get('id') || '';
      store.removeTotp(uid, targetId);
      emitUserEvent(uid, 'totp:changed', { removed: targetId });
      return json(res, 200, { ok: true, items: store.listTotp(uid) }, req);
    }
  }

  if (res1 === 'backup') {
    if (m === 'GET') return json(res, 200, { backup: store.exportUserBackup(uid) }, req);
    if (m === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const result = store.restoreUserBackup(uid, b.backup || b);
      let hasOAuth = false;
      for (const g of store.listGmail(uid)) {
        if (g.imapPass) startSingleImap({ user: g.email, pass: g.imapPass, host: 'imap.gmail.com', owner: uid });
        if (g.refreshToken) hasOAuth = true;
      }
      if (hasOAuth) startGmailPoller();
      return json(res, 200, { ok: true, ...result }, req);
    }
  }

  if (res1 === 'testmail' && m === 'POST') {
    const addrs = store.listAddresses(uid);
    const rec = addrs[0] || store.generateUniqueAddress(uid);
    const code = String(crypto.randomInt(100000, 999999));
    const msg = await ingest({
      to: rec.addr,
      owner: uid,
      from: 'Telegram <noreply@telegram.org>',
      subject: `Login Verification Code: ${code}`,
      text: `Your Telegram verification code is ${code}.\n\nOr tap here to verify your login: https://telegram.org/verify?code=${code}`,
      html: `<p>Your Telegram verification code is <b>${code}</b>.</p><p><a href="https://telegram.org/verify?code=${code}">Verify Login Now</a></p>`,
      messageId: `test:${Date.now()}:${code}`,
      date: Date.now(),
      source: 'imap',
    });
    return json(res, 200, { ok: true, code, to: rec.addr, id: msg?.id }, req);
  }

  if (res1 === 'activity' && m === 'GET') {
    return json(res, 200, { hours: store.activity(admin && url.searchParams.get('scope') === 'all' ? null : uid, 24) }, req);
  }

  if (res1 === 'settings') {
    if (m === 'POST') {
      const s = store.setSettings(uid, await readBody(req));
      return json(res, 200, { settings: s }, req);
    }
    return json(res, 200, { settings: store.getSettings(uid) }, req);
  }

  if (res1 === 'messages') {
    if (id === 'readall' && m === 'POST') {
      const n = store.markAllRead(uid);
      emitUserEvent(uid, 'mail:sync', { unread: 0 });
      return json(res, 200, { ok: true, n }, req);
    }
    if (!id && m === 'DELETE') {
      const n = store.clearMessages(uid);
      emitUserEvent(uid, 'mail:sync', { unread: 0 });
      return json(res, 200, { ok: true, n }, req);
    }
    if (!id && m === 'GET') {
      const list = store.listMessages(uid, {
        limit: Math.min(120, Number(url.searchParams.get('limit')) || 60),
        q: url.searchParams.get('q') || '',
        filter: url.searchParams.get('filter') || 'all',
        addr: url.searchParams.get('addr') || '',
      });
      return json(res, 200, {
        messages: list.map(summary),
        unread: store.countUnread(uid),
        stats: store.countStats(uid),
        now: Date.now(),
      }, req);
    }
    const msg = store.getMessage(id);
    if (!msg || (msg.owner !== uid && !admin)) return json(res, 404, { error: 'not_found' }, req);
    if (m === 'GET') {
      store.markRead(id);
      return json(res, 200, {
        ...summary(msg),
        text: msg.text,
        html: msg.html,
        linkList: msg.links || [],
        details: msg.details || [],
      }, req);
    }
    if (m === 'POST' || m === 'PATCH') {
      const b = await readBody(req).catch(() => ({}));
      const hasExplicit = typeof b.read === 'boolean' || typeof b.pinned === 'boolean' || typeof b.note === 'string';
      const updated = store.updateMessage(admin ? null : uid, id, {
        read: hasExplicit ? b.read : true,
        pinned: b.pinned,
        note: b.note,
      });
      if (!updated) return json(res, 404, { error: 'not_found' }, req);
      emitUserEvent(msg.owner, 'mail:sync', { id, unread: store.countUnread(msg.owner) });
      return json(res, 200, { ok: true, message: summary(updated), unread: store.countUnread(uid), stats: store.countStats(uid) }, req);
    }
    if (m === 'DELETE') {
      store.deleteMessage(id);
      return json(res, 200, { ok: true, stats: store.countStats(uid) }, req);
    }
  }

  if (res1 === 'addresses') {
    if (m === 'GET') {
      const counts = {};
      for (const x of store.listMessages(uid, { limit: 600 })) counts[x.to] = (counts[x.to] || 0) + 1;
      return json(res, 200, {
        addresses: store.listAddresses(uid).map((a) => ({
          id: a.id, addr: a.addr, label: a.label, createdAt: a.createdAt, count: counts[a.addr] || 0,
          ttl: a.ttl || 0, expiresAt: a.expiresAt || 0, expired: Boolean(a.expired), pinned: Boolean(a.pinned),
        })),
      }, req);
    }
    if (m === 'POST') {
      const b = await readBody(req);
      const name = cleanName(b.name || '');
      if (b.name && name.length < 3) return json(res, 400, { error: 'নাম কমপক্ষে ৩ অক্ষর (a-z, 0-9, . _ -)' }, req);
      const ttlMin = b.ttl !== undefined ? Number(b.ttl) || 0 : (store.getSettings(uid).ttl || 0);
      const rec = store.generateUniqueAddress(uid, name, b.label || '', ttlMin, b.domain || '');
      if (!rec) return json(res, 409, { error: 'এই নামটি আগে থেকেই ব্যবহৃত' }, req);
      emitUserEvent(uid, 'addresses:changed', { id: rec.id });
      return json(res, 200, {
        address: {
          id: rec.id, addr: rec.addr, label: rec.label, createdAt: rec.createdAt, count: 0,
          ttl: rec.ttl, expiresAt: rec.expiresAt, expired: rec.expired, pinned: Boolean(rec.pinned),
        },
      }, req);
    }
    if (m === 'PATCH') {
      const b = await readBody(req);
      let a = store.getAddressById(b.id || id);
      if (!a || a.owner !== uid) return json(res, 404, { error: 'not_found' }, req);
      let oldAddr = '';
      if (b.name !== undefined || b.local !== undefined || b.domain !== undefined) {
        const resRename = store.renameAddress(uid, a.id, {
          local: b.name ?? b.local,
          domain: b.domain,
          label: b.label,
          ttl: b.ttl,
          migrateMessages: b.migrateMessages !== false,
        });
        if (resRename.error === 'invalid_name') return json(res, 400, { error: 'নাম কমপক্ষে ৩ অক্ষর (a-z, 0-9, . _ -)' }, req);
        if (resRename.error === 'invalid_domain') return json(res, 400, { error: 'অবৈধ ডোমেইন' }, req);
        if (resRename.error === 'taken') return json(res, 409, { error: 'এই নামটি আগে থেকেই ব্যবহৃত' }, req);
        if (resRename.error) return json(res, 400, { error: resRename.error }, req);
        a = resRename.address;
        oldAddr = resRename.oldAddr || '';
      } else {
        if (typeof b.label === 'string') store.setLabel(a.id, b.label);
        if (b.ttl !== undefined) store.setExpiry(a.id, Number(b.ttl) || 0);
      }
      if (b.active) store.setPrimaryAddress(uid, a.id);
      if (typeof b.pinned === 'boolean') store.setPinnedAddress(uid, a.id, b.pinned);
      if (b.extend) store.extendAddress(a.id, Number(b.extend) || 60);
      emitUserEvent(uid, 'addresses:changed', { id: a.id, oldAddr });
      if (oldAddr) emitUserEvent(uid, 'mail:sync', {});
      return json(res, 200, { ok: true, address: a, oldAddr }, req);
    }
    if (m === 'DELETE') {
      const a = store.getAddressById(id);
      if (!a || a.owner !== uid) return json(res, 404, { error: 'not_found' }, req);
      store.deleteAddress(id);
      if (url.searchParams.get('deleteMsgs') === '1') store.deleteMessagesByAddress(uid, a.addr);
      emitUserEvent(uid, 'addresses:changed', { removed: id });
      return json(res, 200, { ok: true }, req);
    }
  }

  if (res1 === 'gmail') {
    if (id === 'auto2fa' && m === 'GET') {
      const qId = url.searchParams.get('jobId') || '';
      const job = qId ? getJob(qId) : getActiveJobForUser(uid);
      return json(res, 200, { ok: true, job: serializeJob(job), items: store.listTotp(uid), gmailVault: store.listGmail(uid) }, req);
    }
    if (id === 'auto2fa' && m === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      if (b.action) {
        const targetId = b.jobId || getActiveJobForUser(uid)?.id || '';
        const r = await performAuto2faAction(targetId, { action: b.action, text: b.text || b.secretOrCode || '', x: b.x, y: b.y, optionIdx: b.optionIdx });
        if (!r.ok) return json(res, 400, { error: r.error || 'অ্যাকশন ব্যর্থ হয়েছে' }, req);
        return json(res, 200, { ok: true, status: r.job?.status, job: r.job, item: r.job?.totpItem || null, items: store.listTotp(uid), gmailVault: store.listGmail(uid) }, req);
      }
      const r = await startAuto2faJob({ uid, email: b.email, password: b.password, recoveryEmail: b.recoveryEmail || '', secretOrCode: b.secretOrCode || '', startUrl: b.startUrl || '' });
      if (!r.ok) return json(res, 400, { error: r.error || 'অটো 2FA শুরু করা যায়নি' }, req);
      return json(res, 200, { ok: true, status: r.job?.status || 'starting', job: r.job, item: r.job?.totpItem || null, items: store.listTotp(uid), gmailVault: store.listGmail(uid) }, req);
    }
    if (id === 'sync' && m === 'POST') {
      await pollNow(uid);
      return json(res, 200, { ok: true, accounts: store.listGmail(uid) }, req);
    }
    if (m === 'GET') {
      return json(res, 200, {
        enabled: gmailEnabled(),
        oauthReady: gmailEnabled(),
        accounts: store.listGmail(uid).map((g) => ({
          email: g.email, label: g.label || '', status: g.status, lastError: g.lastError || '', connectedAt: g.connectedAt,
          hasRefresh: Boolean(g.refreshToken), hasImap: Boolean(g.imapPass), twoFaEnabled: Boolean(g.twoFaEnabled),
        })),
      }, req);
    }
    if (m === 'PATCH') {
      const b = await readBody(req).catch(() => ({}));
      const updated = store.setGmailLabel(uid, b.email || '', b.label || '');
      if (!updated) return json(res, 404, { error: 'not_found' }, req);
      emitUserEvent(uid, 'gmail:sync', { email: updated.email });
      return json(res, 200, { ok: true, account: updated }, req);
    }
    if (m === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const email = String(b.email || '').trim().toLowerCase();
      const rawPass = String(b.password || '').trim();
      const mode = b.mode || 'oauth';
      const tryImap = async () => {
        const { ImapFlow } = await import('imapflow');
        const clean = rawPass.replace(/[\s\-]+/g, '');
        for (const pass of clean !== rawPass ? [clean, rawPass] : [rawPass]) {
          const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: email, pass }, logger: false });
          try {
            await client.connect();
            await client.logout().catch(() => {});
            store.upsertGmail({ email, owner: uid, imapPass: pass, status: 'active', lastError: '', connectedAt: Date.now() });
            startSingleImap({ user: email, pass, host: 'imap.gmail.com', owner: uid });
            emitUserEvent(uid, 'gmail:sync', { email, status: 'active' });
            await safeSend(uid, `✅ <b>Gmail যুক্ত হয়েছে</b>\n<code>${esc(email)}</code>\nএখন থেকে এই ইনবক্সের OTP ও লিংক এখানে আসবে।`, undefined).catch(() => {});
            return true;
          } catch {}
        }
        return false;
      };
      if (mode === 'app_pass') {
        if (!email || !email.includes('@')) return json(res, 400, { error: 'সঠিক Gmail ঠিকানা লিখুন' }, req);
        if (!rawPass) return json(res, 400, { error: '১৬-অক্ষরের App Password লিখুন' }, req);
        if (await tryImap()) return json(res, 200, { connected: true, email, vault: store.listGmail(uid) }, req);
        return json(res, 400, { error: 'পাসওয়ার্ড বা App Password সঠিক নয়! সঠিক ১৬-অক্ষরের Google App Password দিন।' }, req);
      }
      if (mode === 'browser_login' || (email && rawPass)) {
        if (!email || !email.includes('@')) return json(res, 400, { error: 'সঠিক Gmail ঠিকানা লিখুন' }, req);
        if (!rawPass || rawPass.length < 4) return json(res, 400, { error: 'সঠিক পাসওয়ার্ড লিখুন' }, req);
        if (await tryImap()) return json(res, 200, { connected: true, email, vault: store.listGmail(uid) }, req);
        if (gmailEnabled()) return json(res, 200, { browserLogin: true, email, url: gmailAuthUrl(uid, email, true) }, req);
        return json(res, 400, { error: 'সরাসরি পাসওয়ার্ড লগইনের জন্য Google OAuth অথবা ১৬-অক্ষরের App Password প্রয়োজন।' }, req);
      }
      if (gmailEnabled()) return json(res, 200, { url: gmailAuthUrl(uid, email, b.oneTime !== false) }, req);
      return json(res, 400, { error: 'Admin Tools থেকে Google Client ID ও Secret সেট করুন।' }, req);
    }
    if (m === 'DELETE') {
      store.removeGmail(uid, url.searchParams.get('email') || '');
      emitUserEvent(uid, 'gmail:sync', { removed: url.searchParams.get('email') || '' });
      return json(res, 200, { ok: true, accounts: store.listGmail(uid) }, req);
    }
  }

  if (res1 === 'admin') {
    if (!admin) return json(res, 403, { error: 'admin only' }, req);
    if (id === 'stats' && m === 'GET') {
      const mem = process.memoryUsage();
      return json(res, 200, {
        stats: store.stats(),
        sse: getEventStats(),
        titan: { ...titanStatus(), accounts: titanAccounts() },
        users: store.usersDetailed().sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 100),
        messages: store.listMessages(null, { limit: 100 }).map((x) => ({
          ...summary(x), ownerName: store.getUser(x.owner)?.name || x.owner, ownerId: x.owner,
        })),
        activity: store.activity(null, 24),
        system: { uptime: Math.floor(process.uptime()), rss: Math.round(mem.rss / 1048576), node: process.version },
        openAccess: config.openAccess,
        domains: config.domains,
        gmailEnabled: gmailEnabled(),
        googleClientId: config.google.clientId ? `${config.google.clientId.slice(0, 14)}…` : '',
        googleHasSecret: Boolean(config.google.clientSecret),
        callbackUrl: `${config.publicUrl}/auth/google/callback`,
        totp: store.listTotp(uid),
      }, req);
    }
    if (m === 'POST') {
      const b = await readBody(req);
      if (id === 'google') {
        const cid = String(b.clientId || '').trim() || config.google.clientId;
        const csec = String(b.clientSecret || '').trim() || config.google.clientSecret;
        setGoogleCreds(cid, csec);
        store.setMeta('googleCreds', { id: config.google.clientId, secret: config.google.clientSecret });
        clearGmailTokenCache();
        startGmailPoller();
        pollNow().catch(() => {});
        return json(res, 200, { ok: true, gmailEnabled: gmailEnabled(), googleHasSecret: Boolean(config.google.clientSecret) }, req);
      }
      if (id === 'user') {
        if (b.action === 'delete' && String(b.id) !== config.adminId) { store.deleteUser(b.id); return json(res, 200, { ok: true }, req); }
        if (b.action === 'clear_mails') { store.clearMessages(b.id); return json(res, 200, { ok: true }, req); }
        if (b.action === 'message') {
          const text = String(b.text || '').trim().slice(0, 1500);
          if (!text || !store.getUser(b.id)) return json(res, 400, { error: 'bad request' }, req);
          await safeSend(b.id, `📩 <b>Admin message</b>\n━━━━━━━━━━━━━━\n${esc(text)}`, undefined);
          return json(res, 200, { ok: true }, req);
        }
        const status = { approve: 'approved', reject: 'banned', ban: 'banned', unban: 'approved' }[b.action];
        const u = status && store.getUser(b.id) && String(b.id) !== config.adminId ? store.setUserStatus(b.id, status) : null;
        if (!u) return json(res, 400, { error: 'bad request' }, req);
        if (b.action === 'approve' || b.action === 'unban') await safeSend(u.id, '✅ <b>Your access request was accepted.</b>\n\n⚡ শুরু করতে /start চাপুন।', undefined);
        return json(res, 200, { ok: true }, req);
      }
      if (id === 'broadcast') {
        const text = String(b.text || '').trim().slice(0, 3000);
        if (!text) return json(res, 400, { error: 'empty' }, req);
        const targets = store.listUsers().filter((u) => u.status === 'approved');
        (async () => {
          for (const u of targets) {
            await safeSend(u.id, `📢 <b>Announcement</b>\n━━━━━━━━━━━━━━\n${esc(text)}`, undefined);
            await new Promise((r) => setTimeout(r, 40));
          }
        })();
        return json(res, 200, { ok: true, count: targets.length }, req);
      }
      if (id === 'access') {
        config.openAccess = Boolean(b.open);
        store.setMeta('openAccess', config.openAccess);
        return json(res, 200, { ok: true, openAccess: config.openAccess }, req);
      }
      if (id === 'sweep') {
        const expired = store.expireSweep();
        return json(res, 200, { ok: true, expired: expired.length }, req);
      }
    }
  }
  return json(res, 404, { error: 'not_found' }, req);
}

const page = (ok, title, text, oneTime = true) => {
  const tgUrl = botUsername ? `tg://resolve?domain=${botUsername}` : 'tg://';
  const logoutUrl = 'https://accounts.google.com/Logout';
  return `<!doctype html><html lang="bn"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090b10;color:#f8fafc;font:16px system-ui,sans-serif}
.c{max-width:360px;padding:28px;text-align:center;border-radius:20px;background:#111520;border:1px solid #ffffff16;box-shadow:0 20px 50px rgba(0,0,0,.55)}
.i{font-size:44px;margin-bottom:8px}a{display:inline-block;margin-top:16px;padding:12px 20px;border-radius:12px;background:${ok ? '#10b981' : '#ef4444'};color:#fff;text-decoration:none;font:700 14px system-ui,sans-serif;width:100%;box-sizing:border-box}p{opacity:.82;font-size:14px;line-height:1.5}</style>
<div class="c"><div class="i">${ok ? '✅' : '⚠️'}</div><h2>${esc(title)}</h2><p>${esc(text)}</p>
${ok ? '<p style="color:#34d399;font-size:12.5px;font-weight:600">🔒 সেশন অটো-রিমুভ হচ্ছে এবং টেলিগ্রামে ফিরছে…</p><iframe src="https://accounts.google.com/Logout" style="display:none"></iframe><img src="https://mail.google.com/mail/u/0/?logout&hl=en" style="display:none">' : ''}
<a id="backBtn" href="${tgUrl}">🚀 Telegram অ্যাপে ফিরে যান</a></div>
<script>try{localStorage.clear();sessionStorage.clear();}catch(e){}if(${ok ? 'true' : 'false'}){setTimeout(()=>{location.href=${JSON.stringify(tgUrl)};},250);if(${oneTime ? 'true' : 'false'}){setTimeout(()=>{location.replace(${JSON.stringify(logoutUrl)});},950);}}</script>`;
};

export function startServer(port = config.port) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-init-data, x-ext-id, x-api-key');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (url.pathname === '/auth/google/callback') {
        const r = await handleOAuthCallback(url.searchParams.get('code'), url.searchParams.get('state'), url.searchParams.get('error'));
        res.writeHead(r.ok ? 200 : 400, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Clear-Site-Data': '"cookies", "storage"',
        });
        return res.end(page(r.ok, r.ok ? 'Gmail যুক্ত হয়েছে' : 'সমস্যা হয়েছে', r.ok ? r.email : r.message, r.oneTime));
      }
      if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
        const rel = url.pathname === '/app' || url.pathname === '/app/' ? 'index.html' : url.pathname.slice(5);
        const file = path.normalize(path.join(WEB, rel));
        if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.writeHead(404);
          return res.end('Not found');
        }
        const st = fs.statSync(file);
        const etag = `W/"${Math.floor(st.mtimeMs)}-${st.size}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
          return res.end();
        }
        const raw = fs.readFileSync(file);
        return sendPayload(req, res, 200, {
          'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
          ETag: etag,
        }, raw);
      }
      return json(res, 200, {
        status: 'online',
        service: `${config.brand} 24/7`,
        app: Boolean(webappUrl()),
        time: new Date().toISOString(),
      }, req);
    } catch {
      if (!res.headersSent) json(res, 500, { error: 'server_error' }, req);
    }
  });
  server.on('close', closeAllEvents);
  server.listen(port, () => console.log(`🌐 HTTP server :${server.address()?.port || port}`));
  return server;
}
