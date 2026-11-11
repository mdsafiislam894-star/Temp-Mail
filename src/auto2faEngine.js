import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import { spawn } from 'child_process';
import * as store from './store.js';
import { safeSend, sendBotPhoto } from './notify.js';
import { btn, rows, HR } from './ui.js';
import { escapeHtml as esc } from './lib/mailparse.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BINS = [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_BIN, '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].filter(Boolean);
export const findChromiumBinary = () => BINS.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
import('@sparticuz/chromium').then((m) => (m.default || m).executablePath()).then((p) => { if (p) { BINS.unshift(p); try { fs.chmodSync(p, 0o755); } catch {} } }).catch(() => {});
class CdpSocket {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.seq = 1; this.pending = new Map(); this.socket = null; this.buf = Buffer.alloc(0); this.closed = false; }
  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.wsUrl);
      const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } });
      const tm = setTimeout(() => { req.destroy(); reject(new Error('CDP timeout')); }, 8000);
      req.on('upgrade', (res, sock, head) => {
        clearTimeout(tm); this.socket = sock;
        if (head?.length) this._onData(head);
        sock.on('data', (c) => this._onData(c));
        sock.on('close', () => this._cleanup(new Error('closed')));
        sock.on('error', (e) => this._cleanup(e));
        resolve(this);
      });
      req.on('error', (e) => { clearTimeout(tm); reject(e); });
      req.end();
    });
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const op = this.buf[0] & 15, msk = (this.buf[1] & 128) !== 0;
      let len = this.buf[1] & 127, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const mb = msk ? 4 : 0;
      if (this.buf.length < off + mb + len) return;
      let pay = this.buf.subarray(off + mb, off + mb + len);
      if (msk) { const m = this.buf.subarray(off, off + 4); pay = Buffer.from(pay); for (let i = 0; i < pay.length; i++) pay[i] ^= m[i & 3]; }
      this.buf = this.buf.subarray(off + mb + len);
      if (op === 1) {
        try {
          const msg = JSON.parse(pay.toString('utf8'));
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.t);
            msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
          }
        } catch {}
      } else if (op === 8) this.close();
      else if (op === 9) this._frame(10, pay);
    }
  }
  _frame(op, data) {
    if (!this.socket || this.closed) return;
    const l = data.length;
    const h = Buffer.alloc(l < 126 ? 6 : l < 65536 ? 8 : 14);
    h[0] = 128 | op;
    if (l < 126) h[1] = 128 | l;
    else if (l < 65536) { h[1] = 254; h.writeUInt16BE(l, 2); }
    else { h[1] = 255; h.writeBigUInt64BE(BigInt(l), 2); }
    const m = crypto.randomBytes(4); m.copy(h, h.length - 4);
    const out = Buffer.alloc(l);
    for (let i = 0; i < l; i++) out[i] = data[i] ^ m[i & 3];
    try { this.socket.write(Buffer.concat([h, out])); } catch {}
  }
  send(method, params = {}, ms = 15000) {
    if (this.closed || !this.socket) return Promise.reject(new Error('closed'));
    const id = this.seq++;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('timeout ' + method)); }, ms);
      this.pending.set(id, { res, rej, t });
      this._frame(1, Buffer.from(JSON.stringify({ id, method, params }), 'utf8'));
    });
  }
  _cleanup(e) { this.closed = true; for (const [, p] of this.pending) { clearTimeout(p.t); p.rej(e); } this.pending.clear(); }
  close() { this._cleanup(new Error('closed')); try { this.socket?.destroy(); } catch {} }
}

export class CdpBrowser {
  constructor() { this.proc = null; this.cdp = null; this.dir = `/tmp/chr_a2fa_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }
  async launch() {
    const bin = findChromiumBinary();
    if (!bin) throw new Error('Chromium binary পাওয়া যায়নি');
    fs.mkdirSync(this.dir, { recursive: true });
    this.proc = spawn(bin, ['--headless', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-zygote', '--disable-blink-features=AutomationControlled', '--window-size=412,840', `--user-data-dir=${this.dir}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise((res, rej) => {
      const tm = setTimeout(() => rej(new Error('Chromium timeout')), 12000);
      let s = '';
      this.proc.stderr.on('data', (c) => { s += c.toString(); const m = s.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(tm); res(m[1]); } });
      this.proc.on('exit', (k) => { clearTimeout(tm); rej(new Error('exit ' + k)); });
    });
    const u = new URL(wsUrl);
    const list = await new Promise((res, rej) => http.get(`http://${u.hostname}:${u.port}/json/list`, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
    const tgt = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || list[0];
    this.cdp = await new CdpSocket(tgt.webSocketDebuggerUrl).connect();
    await this.cdp.send('Page.enable'); await this.cdp.send('Runtime.enable'); await this.cdp.send('Network.enable');
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 840, deviceScaleFactor: 2, mobile: true });
    await this.cdp.send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', acceptLanguage: 'en-US,en;q=0.9', platform: 'Linux armv8l' });
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'Object.defineProperty(navigator,"webdriver",{get:()=>undefined});' });
    return this;
  }
  async goto(url, ms = 900) { await this.cdp.send('Page.navigate', { url }); await sleep(ms); }
  async eval(fn, ...args) {
    const expr = typeof fn === 'function' ? `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})` : String(fn);
    const r = await this.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r?.result?.value;
  }
  async clickCoords(x, y) {
    const px = Math.max(1, Math.min(410, Math.round(Number(x) || 200))), py = Math.max(1, Math.min(838, Math.round(Number(y) || 400)));
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
    await sleep(50);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 });
  }
  async pressEnter() {
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
    await sleep(40);
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
  }
  async typeInto(sels, text, enter = true) {
    const pt = await this.eval(function (sl) {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 10 && r.height > 10 && s.visibility !== 'hidden' && s.display !== 'none'; };
      let el = null;
      for (const s of sl) { el = Array.from(document.querySelectorAll(s)).find(vis); if (el) break; }
      if (!el) el = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')).find(vis);
      if (!el) return null;
      el.scrollIntoView({ block: 'center' }); el.focus(); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true }));
      const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, sels);
    if (!pt) return false;
    await this.clickCoords(pt.x, pt.y); await sleep(90);
    await this.cdp.send('Input.insertText', { text: String(text) });
    await this.eval(function (v) { const e = document.activeElement; if (e && 'value' in e) { if (!e.value) e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } }, String(text));
    await sleep(100);
    if (enter) await this.pressEnter();
    return true;
  }
  async clickMatching(pats = [], sels = []) {
    const pt = await this.eval(function (ps, sl) {
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 8 && r.height > 8 && s.visibility !== 'hidden' && s.display !== 'none'; };
      for (const s of sl) { const e = Array.from(document.querySelectorAll(s)).find(vis); if (e) { e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); e.click(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (e.innerText || e.value || '').trim().slice(0, 40) }; } }
      const rxs = ps.map((p) => new RegExp(p, 'i'));
      const all = Array.from(document.querySelectorAll('button,[role="button"],a,input[type="submit"],input[type="button"],span[jsname],div[role="link"]')).filter(vis);
      for (const rx of rxs) { const h = all.find((e) => rx.test((e.innerText || e.textContent || e.value || e.getAttribute('aria-label') || '').trim())); if (h) { h.scrollIntoView({ block: 'center' }); const r = h.getBoundingClientRect(); h.click(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (h.innerText || '').trim().slice(0, 40) }; } }
      return null;
    }, pats, sels);
    if (pt) { await this.clickCoords(pt.x, pt.y); return pt; }
    return null;
  }
  async screenshot() { try { const r = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 68 }); return r?.data ? `data:image/jpeg;base64,${r.data}` : ''; } catch { return ''; } }
  async close() { try { this.cdp?.close(); } catch {} try { this.proc?.kill('SIGKILL'); } catch {} try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch {} }
}

const jobs = new Map(), userActiveJob = new Map();
let botPendingHook = null, imapConnectHook = null;
export const registerAuto2faBotHook = (fn) => { botPendingHook = fn; };
export const registerAuto2faImapHook = (fn) => { imapConnectHook = fn; };
export const formatSecretSpaced = (s = '') => String(s || '').toLowerCase().replace(/[^a-z2-7]/g, '').replace(/(.{4})/g, '$1 ').trim();

export function extractSecretFromText(raw = '') {
  const s = String(raw || '').trim(); if (!s) return '';
  const u = s.match(/[?&]secret=([A-Za-z2-7=\s\-]+)/i);
  if (u) { const c = u[1].replace(/[^A-Za-z2-7]/g, '').toUpperCase(); if (c.length >= 16 && store.b32ToBytes(c).length >= 10) return c; }
  const sp = s.match(/\b(?:[A-Za-z2-7]{4}[\s\-]+){3,15}[A-Za-z2-7]{4}\b/);
  if (sp) { const c = sp[0].replace(/[^A-Za-z2-7]/g, '').toUpperCase(); if (c.length >= 16 && store.b32ToBytes(c).length >= 10) return c; }
  const cp = s.replace(/[\s\-=]+/g, '').toUpperCase();
  return /^[A-Z2-7]{16,64}$/.test(cp) && store.b32ToBytes(cp).length >= 10 ? cp : '';
}

const addJobLog = (j, m) => { j.logs.push({ t: Date.now(), msg: m }); if (j.logs.length > 20) j.logs.shift(); j.stepTitle = m; j.updatedAt = Date.now(); };
export const getJob = (id) => jobs.get(String(id || '')) || null;
export const getActiveJobForUser = (uid) => { const id = userActiveJob.get(String(uid)); return id ? jobs.get(id) || null : null; };

export function serializeJob(j) {
  if (!j) return null;
  const lv = j.secret ? store.computeTotp(j.secret) : null;
  return { id: j.id, uid: j.uid, email: j.email, status: j.status, step: j.step, stepTitle: j.stepTitle, challengeType: j.challengeType, challengePrompt: j.challengePrompt, promptNumber: j.promptNumber, options: j.options || [], screenshot: j.screenshot || '', secret: j.secret || '', secretFormatted: j.secret ? formatSecretSpaced(j.secret) : '', totpCode: lv?.code || j.totpCode || '', totpLeft: lv?.left || 0, totpItem: j.totpItem || null, error: j.error || '', logs: j.logs || [], updatedAt: j.updatedAt };
}

async function notifyChallenge(j, cap, extra = []) {
  try {
    if (botPendingHook) botPendingHook(j.uid, j.id, j.status);
    j.screenshot = j.screenshot || (j.browser ? await j.browser.screenshot() : '');
    const kb = rows(...extra, [btn.cb('✅ ফোনে Approve করেছি / কন্টিনিউ', `a2fa:cont:${j.id}`, 'success')], [btn.cb('🔄 Try Another Way', `a2fa:alt:${j.id}`, 'primary'), btn.cb('📸 লাইভ স্ক্রিন', `a2fa:snap:${j.id}`)], [btn.app('🚀 মিনি অ্যাপে লাইভ দেখুন', '?tab=gmail', 'primary')], [btn.cb('🛑 বাতিল করুন', `a2fa:stop:${j.id}`, 'danger')]);
    j.screenshot ? await sendBotPhoto(j.uid, j.screenshot, cap, kb) : await safeSend(j.uid, cap, kb);
  } catch {}
}

async function finalizeSuccess(j, secret, verified = true) {
  const clean = secret.replace(/[^A-Za-z2-7]/g, '').toUpperCase();
  j.secret = clean;
  const item = store.addTotp(j.uid, `Google (${j.email})`, clean);
  j.totpItem = item; j.totpCode = item?.code || store.computeTotp(clean).code; j.status = 'completed'; j.step = 5;
  addJobLog(j, '✅ 2FA Secret Key ভল্টে সেভ ও 2-Step Verification অন সম্পন্ন!');
  store.upsertGmail({ email: j.email, owner: j.uid, twoFaEnabled: true, totpId: item?.id || '', status: 'active', lastError: '', connectedAt: Date.now() });
  if (j.password && imapConnectHook) imapConnectHook(j.uid, j.email, j.password).catch(() => {});
  if (botPendingHook) botPendingHook(j.uid, null, 'completed');
  const sp = formatSecretSpaced(clean);
  const msg = `✅ <b>ফুল অটোমেটিক 2FA সফলভাবে চালু ও ভেরিফাইড হয়েছে!</b>\n${HR}\n📧 <b>Gmail:</b> <code>${esc(j.email)}</code>\n🔑 <b>2FA Secret Key:</b>\n<code>${esc(sp)}</code>\n🔢 <b>বর্তমান লাইভ কোড:</b> <code>${esc(j.totpCode)}</code>\n🛡️ <b>স্ট্যাটাস:</b> ${verified ? 'Google Authenticator কোড অটো-ভেরিফাই করে 2-Step Verification চালু করা হয়েছে' : '2FA ভল্টে যুক্ত ও সক্রিয় করা হয়েছে'} এবং অ্যাপের <b>2FA Auth</b> ভল্টে সেভ হয়ে গেছে!`;
  await safeSend(j.uid, msg, rows([btn.copy(`📋 2FA কোড: ${j.totpCode}`, j.totpCode, 'success'), btn.copy('🔑 Secret Key কপি', sp, 'primary')], [btn.cb('🔐 সব 2FA কোড', 'totp:list', 'primary'), btn.app('🚀 Open 2FA Vault', '?tab=admin', 'primary')])).catch(() => {});
}

async function inspectGooglePage(b) {
  return await b.eval(function () {
    const url = location.href, title = document.title || '', bodyText = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim();
    const isVis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 8 && r.height > 8 && s.visibility !== 'hidden' && s.display !== 'none'; };
    let foundSecret = '';
    const html = document.body ? document.body.innerHTML : '';
    const u = html.match(/otpauth:\/\/totp\/[^"'\s<>]+secret=([A-Za-z2-7]+)/i);
    if (u) foundSecret = u[1].toUpperCase();
    if (!foundSecret) {
      const dlg = document.querySelector('[role="dialog"],[aria-modal="true"]') || document.body;
      for (const el of Array.from((dlg || document).querySelectorAll('strong,b,code,[data-secret],span'))) {
        if (!isVis(el) || el.children.length > 0 || el.closest('button,a,[role="button"]')) continue;
        const t = (el.innerText || el.getAttribute('data-secret') || '').trim();
        if (/^(?:[a-z2-7]{4}\s+){3,7}[a-z2-7]{4}$/i.test(t) || /^[A-Z2-7]{16,32}$/.test(t.replace(/\s+/g, ''))) {
          const c = t.replace(/\s+/g, '').toUpperCase();
          if (c.length >= 16 && (/\d|[2-7]/.test(c) || el.tagName === 'STRONG' || el.tagName === 'CODE')) { foundSecret = c; break; }
        }
      }
      if (!foundSecret && dlg) {
        const dt = Array.from(dlg.querySelectorAll('*')).filter((e) => isVis(e) && e.children.length === 0 && !e.closest('button,a,[role="button"],h1,h2,h3')).map((e) => (e.textContent || '').trim()).filter(Boolean).join(' \n ');
        const ms = dt.match(/\b(?:[a-z2-7]{4}[ \t]+){3,7}[a-z2-7]{4}\b/i);
        if (ms && /\d|[2-7]/.test(ms[0])) foundSecret = ms[0].replace(/\s+/g, '').toUpperCase();
      }
    }
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')).filter(isVis).map((i) => ({ type: i.type || 'text', name: i.name || '', id: i.id || '', placeholder: i.placeholder || '', aria: i.getAttribute('aria-label') || '' }));
    const hasEmailInput = inputs.some((i) => i.type === 'email' || i.id === 'identifierId' || i.name === 'identifier');
    const hasPassInput = inputs.some((i) => i.type === 'password' || i.name === 'Passwd');
    const cap = document.querySelector('#captchaimg,img[src*="captcha" i],iframe[src*="recaptcha" i],input[name="ca"]');
    const hasCaptcha = Boolean(cap && isVis(cap));
    const errEl = Array.from(document.querySelectorAll('[aria-live="assertive"],[jsname="B34EJ"],.o6cuMc,.dEOOab')).find((e) => isVis(e) && e.innerText.trim().length > 2);
    const samp = document.querySelector('samp,[data-challenge-number],.vxx8jf');
    const promptNumber = samp && isVis(samp) && /^\d{1,3}$/.test(samp.innerText.trim()) ? samp.innerText.trim() : '';
    const options = Array.from(document.querySelectorAll('[data-challengetype],li div[role="link"],ul li[jsaction]')).filter(isVis).map((e, idx) => ({ idx, text: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90) })).filter((o) => o.text.length > 4 && !/need help|learn more/i.test(o.text)).slice(0, 6);
    const heading = Array.from(document.querySelectorAll('h1,h2,[role="heading"]')).filter(isVis).map((h) => h.innerText.trim()).filter(Boolean).join(' — ');
    return { url, title, heading, bodyText: bodyText.slice(0, 1800), foundSecret, inputs, hasEmailInput, hasPassInput, hasCaptcha, errorText: errEl ? errEl.innerText.trim() : '', promptNumber, options };
  });
}

function findInboxOtp(uid, since) {
  for (const m of store.listMessages(uid, { limit: 15 })) {
    if ((m.date || 0) >= since - 60000 && m.otp && /google|gmail/i.test(`${m.from || ''} ${m.subject || ''} ${m.service?.name || ''}`)) return String(m.otp).replace(/^G-/i, '').trim();
  }
  return '';
}

async function runPipeline(j) {
  const b = new CdpBrowser(); j.browser = b;
  try {
    addJobLog(j, '🚀 হেডলেস ক্রোমিয়াম ব্রাউজার ইঞ্জিন চালু হচ্ছে…');
    await b.launch();
    j.step = 1; j.status = 'logging_in';
    addJobLog(j, `🔐 ধাপ ১/৫: ${j.email}-এ গুগল লগইন শুরু হচ্ছে…`);
    await safeSend(j.uid, `🤖 <b>অটো 2FA অটোমেশন বট চালু হয়েছে!</b>\n📧 অ্যাকাউন্ট: <code>${esc(j.email)}</code>\n⏳ <b>ধাপ ১/৫:</b> গুগল সার্ভারে অটোমেটিক লগইন করা হচ্ছে…`, rows([btn.app('🚀 লাইভ প্রগ্রেস দেখুন', '?tab=gmail', 'primary'), btn.cb('🛑 বাতিল করুন', `a2fa:stop:${j.id}`, 'danger')])).catch(() => {});
    await b.goto(j.startUrl || 'https://accounts.google.com/v3/signin/identifier?hl=en&continue=https%3A%2F%2Fmyaccount.google.com%2Fsigninoptions%2Ftwo-step-verification&flowName=GlifWebSignIn&flowEntry=ServiceLogin', 900);
    j.screenshot = await b.screenshot();
    let st = await inspectGooglePage(b);
    if (st.hasEmailInput) {
      addJobLog(j, '📧 ইমেইল অ্যাড্রেস টাইপ করে Next দেওয়া হচ্ছে…');
      await b.typeInto(['input[type="email"]', '#identifierId', 'input[name="identifier"]'], j.email, true);
      await sleep(500);
      await b.clickMatching(['^Next$', '^পরবর্তী$', '^Continue$'], ['#identifierNext', 'button[jsname="LgbsSe"]']);
      await sleep(900); j.screenshot = await b.screenshot(); st = await inspectGooglePage(b);
    }
    if (st.errorText && /couldn't find|valid email/i.test(st.errorText)) throw new Error(`গুগল ইমেইলটি খুঁজে পায়নি: ${st.errorText}`);
    for (let w = 0; w < 4 && !st.hasPassInput && !st.hasCaptcha && !/myaccount\.google\.com/i.test(st.url); w++) { await sleep(700); st = await inspectGooglePage(b); }
    if (st.hasPassInput) {
      addJobLog(j, '🔑 পাসওয়ার্ড টাইপ করে লগইন সাবমিট করা হচ্ছে…');
      await b.typeInto(['input[type="password"]', 'input[name="Passwd"]', '#password input'], j.password, true);
      await sleep(500);
      await b.clickMatching(['^Next$', '^পরবর্তী$', '^Sign in$'], ['#passwordNext', 'button[jsname="LgbsSe"]']);
      await sleep(900); j.screenshot = await b.screenshot(); st = await inspectGooglePage(b);
    }
    if (st.errorText && /wrong password|পাসওয়ার্ড ভুল/i.test(st.errorText)) throw new Error('আপনার দেওয়া Gmail পাসওয়ার্ডটি সঠিক নয় (Wrong Password)।');

    j.step = 2; let notifiedKey = '';
    for (let it = 0; it < 90 && !j.cancelled; it++) {
      st = await inspectGooglePage(b); j.screenshot = await b.screenshot();
      if (st.foundSecret && st.foundSecret.length >= 16) break;
      if (/myaccount\.google\.com/i.test(st.url) && !/accounts\.google\.com\/v3\/signin|ServiceLogin/i.test(st.url)) break;
      if (/speedbump|passkey|gds\.google\.com/i.test(st.url) || /simplify your sign-in|create a passkey|skip for now|not now/i.test(st.bodyText)) {
        if (await b.clickMatching(['^Not now$', '^Skip$', '^Remind me later$', '^Cancel$', '^Continue$'])) { await sleep(900); continue; }
      }
      if (st.hasPassInput) {
        await b.typeInto(['input[type="password"]', 'input[name="Passwd"]'], j.password, true);
        await sleep(500); await b.clickMatching(['^Next$', '^Verify$'], ['#passwordNext', 'button[jsname="LgbsSe"]']);
        await sleep(900); continue;
      }
      if (j.recoveryEmail && /confirm your recovery email|enter recovery email/i.test(st.bodyText) && st.inputs.length) {
        await b.typeInto(['input[type="email"]', 'input[name="knowledgePreregisteredEmailResponse"]', 'input[type="text"]'], j.recoveryEmail, true);
        await sleep(500); await b.clickMatching(['^Next$', '^Confirm$'], ['button[jsname="LgbsSe"]']);
        await sleep(900); continue;
      }
      const hasCode = st.inputs.some((i) => i.type === 'tel' || /pin|code|totp|idv/i.test(`${i.name} ${i.id} ${i.placeholder} ${i.aria}`));
      if (hasCode) {
        const otp = findInboxOtp(j.uid, j.startedAt);
        if (otp && otp !== j.lastAutoOtp) {
          j.lastAutoOtp = otp;
          addJobLog(j, `⚡ ইনবক্স থেকে গুগল কোড (${otp}) অটো-সাবমিট করা হচ্ছে…`);
          await b.typeInto(['input[type="tel"]', 'input[name*="Pin" i]', 'input[type="text"]'], otp, true);
          await sleep(500); await b.clickMatching(['^Next$', '^Verify$'], ['button[jsname="LgbsSe"]']);
          await sleep(900); continue;
        }
      }
      if (st.hasCaptcha) { j.status = 'waiting_captcha'; j.challengeType = 'captcha'; j.challengePrompt = st.heading || 'গুগল ক্যাপচা ভেরিফিকেশন সম্পন্ন করুন'; }
      else if (hasCode || st.inputs.length > 0) { j.status = 'waiting_code'; j.challengeType = 'code_input'; j.challengePrompt = st.heading || 'গুগল ভেরিফিকেশন কোড বা রিকভারি তথ্য দিন'; }
      else if (st.options.length > 0) { j.status = 'waiting_approval'; j.challengeType = 'option_list'; j.options = st.options; j.challengePrompt = 'ভেরিফিকেশন পদ্ধতি বেছে নিন:'; }
      else { j.status = 'waiting_approval'; j.challengeType = 'device_prompt'; j.promptNumber = st.promptNumber || ''; j.challengePrompt = st.promptNumber ? `ফোনে Google Prompt-এ Yes চাপুন এবং "${st.promptNumber}" সিলেক্ট করুন।` : (st.heading || 'ফোনে Google Prompt নোটিফিকেশনে Yes / Allow চাপুন।'); }

      const k = `${j.challengeType}:${st.heading}:${st.promptNumber}:${st.options.length}`;
      if (k !== notifiedKey) {
        notifiedKey = k; addJobLog(j, `📲 ধাপ ২/৫: ${j.challengePrompt}`);
        const optRows = (st.options || []).slice(0, 4).map((o) => [btn.cb(`👉 ${o.text.slice(0, 38)}`, `a2fa:opt:${j.id}:${o.idx}`, 'primary')]);
        await notifyChallenge(j, `🤖 <b>অটো 2FA বট — আপনার অ্যাপ্রুভাল/ইনপুট প্রয়োজন!</b>\n${HR}\n📧 <b>Gmail:</b> <code>${esc(j.email)}</code>\n📌 <b>স্ট্যাটাস:</b> ${esc(j.challengePrompt)}\n` + (st.promptNumber ? `🔢 <b>প্রম্পট নাম্বার:</b> <code>${esc(st.promptNumber)}</code>\n` : '') + `\n💡 ফোনে <b>Yes</b> চাপুন অথবা কোড/রিকভারি তথ্য সরাসরি এই বটে মেসেজ হিসেবে লিখে পাঠান!`, optRows);
      }
      await sleep(900);
    }
    if (j.cancelled) throw new Error('অটো 2FA প্রসেস বাতিল করা হয়েছে।');

    j.step = 3; j.status = 'extracting_secret'; j.challengeType = null;
    addJobLog(j, '🔍 ধাপ ৩/৫: গুগল অ্যাকাউন্ট থেকে 2FA Secret Key অটোমেটিক বের করা হচ্ছে…');
    st = await inspectGooglePage(b);
    if (!st.foundSecret) {
      if (!j.startUrl && !/authenticator/i.test(st.bodyText)) await b.goto('https://myaccount.google.com/two-step-verification/authenticator?hl=en', 900);
      st = await inspectGooglePage(b);
      if (st.hasPassInput) { await b.typeInto(['input[type="password"]', 'input[name="Passwd"]'], j.password, true); await sleep(500); await b.clickMatching(['^Next$', '^Verify$'], ['#passwordNext', 'button[jsname="LgbsSe"]']); await sleep(900); st = await inspectGooglePage(b); }
      if (!j.startUrl && (/404|not found/i.test(`${st.title} ${st.heading}`) || (!/authenticator/i.test(st.bodyText) && !st.foundSecret))) {
        await b.goto('https://myaccount.google.com/signinoptions/two-step-verification?hl=en', 900);
        await b.clickMatching(['Authenticator', 'Google Authenticator', 'Get started', 'Turn on 2-Step Verification']); await sleep(900);
      }
      await b.clickMatching(['Set up authenticator', 'Change authenticator app', 'Add authenticator', '\\+ Set up', 'Set up']); await sleep(700);
      await b.clickMatching(["Can't scan it", 'Can’t scan it', 'Cannot scan', 'Enter a setup key']); await sleep(700);
      j.screenshot = await b.screenshot(); st = await inspectGooglePage(b);
    }
    for (let w = 0; w < 40 && !st.foundSecret && !j.secret && !j.cancelled; w++) {
      await b.clickMatching(["Can't scan it", 'Can’t scan it', 'Set up authenticator', 'Change authenticator app']);
      await sleep(700); j.screenshot = await b.screenshot(); st = await inspectGooglePage(b);
      if (st.foundSecret) break;
      if (w === 2) { j.status = 'waiting_approval'; await notifyChallenge(j, `🔐 <b>ধাপ ৩/৫: গুগল 2FA সেটআপ পেজ ওপেন হয়েছে!</b>\n📧 <code>${esc(j.email)}</code>\nস্ক্রিনে কোনো কনফার্মেশন চাইলে নিচে ক্লিক করুন অথবা মিনি অ্যাপে লাইভ ব্রাউজারে ট্যাপ করুন:`); }
    }
    const sec = (j.secret || st.foundSecret || '').replace(/[^A-Za-z2-7]/g, '').toUpperCase();
    if (!sec || sec.length < 16) throw new Error('গুগল পেজ থেকে 2FA Secret Key স্বয়ংক্রিয়ভাবে পাওয়া যায়নি।');
    j.secret = sec;
    addJobLog(j, `🔑 2FA Secret Key সফলভাবে এক্সট্রাক্ট করা হয়েছে (${sec.slice(0, 4)}••••${sec.slice(-4)})!`);
    await b.clickMatching(['^Next$', '^পরবর্তী$', '^Continue$']); await sleep(700);

    j.step = 4; j.status = 'verifying_totp';
    let lv = store.computeTotp(sec);
    if (lv.left <= 3) { await sleep((lv.left + 1) * 1000); lv = store.computeTotp(sec); }
    j.totpCode = lv.code;
    addJobLog(j, `🔢 ধাপ ৪/৫: TOTP কোড (${lv.code}) জেনারেট করে গুগলে অটো-ভেরিফাই করা হচ্ছে…`);
    await b.typeInto(['[role="dialog"] input[type="text"]', '[role="dialog"] input[type="tel"]', 'input[placeholder*="code" i]', 'input[type="tel"]', 'input[type="text"]'], lv.code, true);
    await sleep(500); await b.clickMatching(['^Verify$', '^যাচাই করুন$', '^Next$', '^Confirm$', '^Done$']); await sleep(900);
    st = await inspectGooglePage(b);
    if (/invalid|wrong|try again|didn't match/i.test(`${st.errorText} ${st.bodyText}`)) {
      const rc = lv.nextCode || store.computeTotp(sec, Date.now() + 30000).code;
      await b.typeInto(['[role="dialog"] input', 'input[type="tel"]', 'input[type="text"]'], rc, true);
      await sleep(500); await b.clickMatching(['^Verify$', '^Next$', '^Done$']); await sleep(900);
    }
    j.status = 'turning_on_2sv';
    addJobLog(j, '🛡️ জিমেইলে 2-Step Verification ফাইনাল Turn On করা হচ্ছে…');
    await b.clickMatching(['^Turn on 2-Step Verification$', '^Turn on$', '^Done$', '^চালু করুন$']); await sleep(700);
    await b.clickMatching(['^Turn on$', '^Confirm$', '^Done$']); await sleep(700);
    j.screenshot = await b.screenshot();
    await finalizeSuccess(j, sec, true);
  } catch (e) {
    if (j.status !== 'completed') {
      j.status = 'failed'; j.error = e.message || 'অটো 2FA চলাকালীন সমস্যা হয়েছে'; addJobLog(j, `❌ ${j.error}`);
      if (botPendingHook) botPendingHook(j.uid, null, 'failed');
      await safeSend(j.uid, `⚠️ <b>অটো 2FA স্ট্যাটাস (${esc(j.email)}):</b>\n${esc(j.error)}`, rows([btn.app('🔄 আবার চেষ্টা করুন', '?tab=gmail', 'primary')])).catch(() => {});
    }
  } finally { await b.close(); j.browser = null; }
}

export async function startAuto2faJob({ uid, email, password = '', recoveryEmail = '', secretOrCode = '', startUrl = '' }) {
  const em = String(email || '').trim().toLowerCase();
  if (!em || !em.includes('@')) return { ok: false, error: 'সঠিক Gmail ঠিকানা দিন' };
  const direct = extractSecretFromText(secretOrCode) || extractSecretFromText(password);
  if (direct) {
    const fj = { id: `a2fa_${store.newId(5)}`, uid: String(uid), email: em, password: extractSecretFromText(password) ? '' : password, status: 'completed', step: 5, stepTitle: '', logs: [], startedAt: Date.now(), updatedAt: Date.now() };
    jobs.set(fj.id, fj); userActiveJob.set(String(uid), fj.id);
    await finalizeSuccess(fj, direct, false);
    return { ok: true, job: serializeJob(fj) };
  }
  if (!password || String(password).trim().length < 4) return { ok: false, error: 'আপনার Gmail পাসওয়ার্ড দিন' };
  const prev = getActiveJobForUser(uid);
  if (prev?.browser) { prev.cancelled = true; await prev.browser.close().catch(() => {}); }
  const j = { id: `a2fa_${store.newId(5)}`, uid: String(uid), email: em, password: String(password).trim(), recoveryEmail: String(recoveryEmail || '').trim(), startUrl: startUrl || '', status: 'starting', step: 1, stepTitle: 'অটো 2FA ইঞ্জিন শুরু হচ্ছে…', challengeType: null, challengePrompt: '', promptNumber: '', options: [], screenshot: '', secret: '', totpCode: '', totpItem: null, error: '', logs: [], startedAt: Date.now(), updatedAt: Date.now(), cancelled: false, browser: null };
  jobs.set(j.id, j); userActiveJob.set(String(uid), j.id);
  runPipeline(j).catch((e) => console.error('auto2fa:', e));
  await sleep(300);
  return { ok: true, job: serializeJob(j) };
}

export async function performAuto2faAction(jobId, { action = 'input', text = '', x = 0, y = 0, optionIdx = -1 } = {}) {
  const j = getJob(jobId);
  if (!j) return { ok: false, error: 'সেশন পাওয়া যায়নি বা শেষ হয়ে গেছে' };
  if (action === 'stop') { j.cancelled = true; j.status = 'failed'; j.error = 'ইউজার অটো 2FA বাতিল করেছেন।'; if (j.browser) await j.browser.close().catch(() => {}); return { ok: true, job: serializeJob(j) }; }
  const sec = extractSecretFromText(text);
  if (sec && sec.length >= 16) {
    j.secret = sec;
    if (j.browser) {
      const lv = store.computeTotp(sec);
      await j.browser.clickMatching(['^Next$', '^পরবর্তী$']).catch(() => {}); await sleep(600);
      await j.browser.typeInto(['[role="dialog"] input', 'input[type="tel"]', 'input[type="text"]'], lv.code, true).catch(() => {}); await sleep(500);
      await j.browser.clickMatching(['^Verify$', '^Turn on$', '^Done$']).catch(() => {}); await sleep(700);
    }
    await finalizeSuccess(j, sec, true);
    if (j.browser) await j.browser.close().catch(() => {});
    return { ok: true, job: serializeJob(j) };
  }
  if (!j.browser) return { ok: true, job: serializeJob(j) };
  if (action === 'snap') { j.screenshot = await j.browser.screenshot(); return { ok: true, job: serializeJob(j) }; }
  if (action === 'click') { await j.browser.clickCoords(x, y); await sleep(800); j.screenshot = await j.browser.screenshot(); return { ok: true, job: serializeJob(j) }; }
  if (action === 'alt') { await j.browser.clickMatching(['Try another way', 'More ways to verify', 'অন্য উপায়']); await sleep(900); j.screenshot = await j.browser.screenshot(); j.options = (await inspectGooglePage(j.browser)).options || []; return { ok: true, job: serializeJob(j) }; }
  if (action === 'option' && optionIdx >= 0) {
    await j.browser.eval(function (idx) { const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 8 && r.height > 8 && s.visibility !== 'hidden' && s.display !== 'none'; }; const els = Array.from(document.querySelectorAll('[data-challengetype],li div[role="link"],ul li[jsaction]')).filter(vis); if (els[idx]) els[idx].click(); }, Number(optionIdx));
    await sleep(900); j.screenshot = await j.browser.screenshot(); return { ok: true, job: serializeJob(j) };
  }
  if (action === 'continue') { await j.browser.clickMatching(['^Next$', '^Continue$', '^Verify$', '^Yes$', '^Confirm$', '^Turn on$']).catch(() => {}); await sleep(700); j.screenshot = await j.browser.screenshot(); return { ok: true, job: serializeJob(j) }; }
  if (action === 'input' && text) {
    const ct = String(text).trim().replace(/^G-/i, '');
    await j.browser.typeInto(['input[type="tel"]', 'input[name="idvPin"]', 'input[name="totpPin"]', 'input[name="ca"]', 'input[name="knowledgePreregisteredEmailResponse"]', 'input[type="email"]', 'input[type="text"]'], ct, true);
    await sleep(500); await j.browser.clickMatching(['^Next$', '^Verify$', '^Confirm$', '^Continue$', '^Submit$'], ['#idvPreregisteredPhoneNext', '#totpNext', 'button[jsname="LgbsSe"]']);
    await sleep(900); j.screenshot = await j.browser.screenshot(); return { ok: true, job: serializeJob(j) };
  }
  return { ok: true, job: serializeJob(j) };
}
