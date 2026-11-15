import { renderQrSvg } from '/app/qr.js?v=4';
import {
  computeTotpAsync,
  getCachedTotpSync,
  parseBulkInput,
  buildOtpAuthUri,
  formatCode,
  detectBrand,
  encryptBackup,
  decryptBackup,
} from '/app/totp.js?v=4';

const tg = window.Telegram?.WebApp || null;
const INIT_DATA = tg?.initData || '';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ic = (name, cls = '') =>
  `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;

const S = {
  tab: 'inbox',
  hubSub: 'addrs',
  user: null,
  brand: 'ARIYAN MAIL',
  domains: ['safix.tech', 'mdsafiislam.tech'],
  prefDomain: -1,
  gmailEnabled: false,
  sseToken: '',
  sseReady: false,
  es: null,
  settings: {
    notify: true,
    otpOnly: false,
    style: 'smart',
    theme: 'aurora',
    skin: 'glass',
    ttl: 0,
    muted: [],
    autoCopy: true,
    autoMarkReadOnCopy: false,
    sound: true,
    compact: false,
    liteBlur: false,
    otpFormat: 'spaced',
  },
  addrs: [],
  msgs: [],
  unread: 0,
  stats: { total: 0, unread: 0, otp: 0, pinned: 0 },
  totp: [],
  gmails: [],
  auto2fa: null,
  adminData: null,

  // UI filters
  selectedAddr: '',
  mailFilter: 'all',
  mailQuery: '',
  totpQuery: '',
  totpCat: 'all',
  customDom: '',

  // Active OTP Auto-Copy Dock & Dedupe
  activeOtp: null,
  seenOtpMsgIds: new Set(),
  lastBootLatestId: '',
};

const lsGet = (k, fb = '') => { try { return localStorage.getItem(k) || fb; } catch { return fb; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

function hap(type = 'light') {
  try {
    if (!S.settings.sound) return;
    if (type === 'success' || type === 'error' || type === 'warning') {
      tg?.HapticFeedback?.notificationOccurred?.(type);
    } else {
      tg?.HapticFeedback?.impactOccurred?.(type);
    }
  } catch {}
}

let audioCtx = null;
function playChime(kind = 'otp') {
  if (!S.settings.sound) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const now = audioCtx.currentTime;
    const notes = kind === 'otp' ? [660, 880] : [523.25];
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.08);
      gain.gain.setValueAtTime(0.001, now + i * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.06, now + i * 0.08 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.08 + 0.16);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + i * 0.08);
      osc.stop(now + i * 0.08 + 0.18);
    });
  } catch {}
}

let toastTimer = null;
function toast(msg, dur = 2400) {
  const root = $('#toastRoot');
  if (!root) return;
  root.innerHTML = `<div class="toast">${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { root.innerHTML = ''; }, dur);
}

async function copyText(text) {
  const str = String(text || '').trim();
  if (!str) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(str);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, str.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

async function copyAndNotify(text, label = '') {
  const ok = await copyText(text);
  if (ok) {
    hap('success');
    toast(label ? `✓ ${label}` : `✓ কপি হয়েছে: ${text}`);
  } else {
    hap('warning');
    toast('⚠️ ম্যানুয়ালি সিলেক্ট করে কপি করুন');
  }
  return ok;
}

async function api(path, opts = {}) {
  const headers = { 'x-init-data': INIT_DATA, ...(opts.headers || {}) };
  let body = opts.body;
  if (body && typeof body === 'object' && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(`/api/${path}`, { ...opts, headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function resolveTheme(name) {
  if (name === 'auto') {
    const isLight = tg?.colorScheme === 'light' || (!tg?.colorScheme && window.matchMedia?.('(prefers-color-scheme: light)').matches);
    return isLight ? 'daylight' : 'aurora';
  }
  return name || 'aurora';
}

function applyTheme() {
  const st = S.settings;
  const actualTheme = resolveTheme(st.theme);
  document.documentElement.setAttribute('data-theme', actualTheme);
  document.documentElement.setAttribute('data-skin', st.skin || 'glass');
  if (st.liteBlur) document.documentElement.setAttribute('data-lite', '1');
  else document.documentElement.removeAttribute('data-lite');
  document.body.classList.toggle('compact', Boolean(st.compact));
  lsSet('savedSettings', JSON.stringify({ ...st, theme: actualTheme }));
  try {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg && tg) {
      tg.setHeaderColor?.(bg);
      tg.setBackgroundColor?.(bg);
    }
  } catch {}
  requestAnimationFrame(updateNavPill);
}

function relTime(ts) {
  const diff = Math.max(0, Math.floor((Date.now() - Number(ts || 0)) / 1000));
  if (diff < 45) return 'এখনই';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return new Date(ts).toLocaleDateString('bn-BD', { day: 'numeric', month: 'short' });
}

function fmtTtl(a) {
  if (!a) return '∞ স্থায়ী';
  if (a.expired) return 'মেয়াদ শেষ';
  if (!a.expiresAt) return '∞ স্থায়ী';
  const left = Math.max(1, Math.ceil((a.expiresAt - Date.now()) / 60000));
  if (left >= 60) return `${Math.floor(left / 60)}h ${left % 60 ? `${left % 60}m` : ''}`.trim();
  return `${left}m`;
}

function activeTempAddr() {
  if (S.selectedAddr && !S.selectedAddr.endsWith('@gmail.com')) {
    const found = S.addrs.find((a) => a.addr === S.selectedAddr && !a.expired);
    if (found) return found;
  }
  return S.addrs.find((a) => !a.expired) || S.addrs[0] || null;
}

function persistLocalVaults() {
  try {
    if (S.addrs.length) {
      lsSet('savedAddrs', JSON.stringify(S.addrs.slice(0, 40).map((a) => ({
        addr: a.addr, label: a.label, ttl: a.ttl, pinned: a.pinned,
      }))));
    }
    if (S.totp.length) {
      lsSet('savedTotp', JSON.stringify(S.totp.map((t) => ({
        id: t.id, name: t.name, issuer: t.issuer, category: t.category,
        secret: t.secret, algo: t.algo, digits: t.digits, period: t.period, pinned: t.pinned,
      }))));
    }
    lsSet('savedGmails', JSON.stringify(S.gmails));
    lsSet('selectedMail', S.selectedAddr || '');
  } catch {}
}

// ---------- Smart OTP Auto-Copy Engine ----------
async function triggerOtpArrival(msg) {
  if (!msg?.otp || S.seenOtpMsgIds.has(msg.id)) return;
  S.seenOtpMsgIds.add(msg.id);

  let copied = false;
  if (S.settings.autoCopy) {
    copied = await copyText(msg.otp);
  }
  S.activeOtp = {
    id: msg.id,
    otp: msg.otp,
    service: msg.service?.name || 'Verification',
    to: msg.to,
    link: msg.firstLink || null,
    copied,
    time: msg.date || Date.now(),
  };
  playChime('otp');
  hap('success');
  renderOtpDock();
}

function renderOtpDock() {
  const dock = $('#otpDock');
  if (!dock) return;
  const cur = S.activeOtp;
  if (!cur) { dock.hidden = true; dock.innerHTML = ''; return; }
  dock.hidden = false;
  const formatted = S.settings.otpFormat === 'spaced' ? formatCode(cur.otp) : cur.otp;
  dock.innerHTML = `
    <div class="otp-dock-left">
      <div class="otp-dock-status">
        ${ic(cur.copied ? 'check' : 'bolt', 'ic-sm')}
        <span>${cur.copied ? 'অটো কপি হয়েছে • কীবোর্ডে পেস্ট করুন' : 'নতুন কোড এসেছে • কপি করতে ট্যাপ করুন'}</span>
      </div>
      <div class="otp-dock-code">${esc(formatted)}</div>
      <div class="otp-dock-meta">${esc(cur.service)} • ${esc(cur.to)}</div>
    </div>
    <div class="otp-dock-actions">
      ${cur.link?.url ? `<button type="button" class="btn sm primary" data-act="openDockLink" data-url="${esc(cur.link.url)}">${ic('link', 'ic-sm')}<span>খুলুন</span></button>` : ''}
      <button type="button" class="btn sm ok" data-act="copyDockOtp">${ic(cur.copied ? 'check' : 'copy', 'ic-sm')}<span>${cur.copied ? 'কপিড' : 'কপি'}</span></button>
      <button type="button" class="icon-btn" data-act="dismissDock" aria-label="Close">${ic('x', 'ic-sm')}</button>
    </div>`;
}

// Retry silent copy when returning to foreground if an uncopied OTP was waiting
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshMessages(false);
    if (S.activeOtp && !S.activeOtp.copied && S.settings.autoCopy) {
      copyText(S.activeOtp.otp).then((ok) => {
        if (ok && S.activeOtp) { S.activeOtp.copied = true; renderOtpDock(); }
      });
    }
  }
});

// ---------- SSE Real-time Stream ----------
function setLiveStatus(connected, label) {
  const dot = $('#liveDot');
  const lbl = $('#liveLabel');
  S.sseReady = connected;
  if (dot) dot.classList.toggle('on', connected);
  if (lbl) lbl.textContent = label;
}

function connectEvents() {
  if (!S.sseToken) return;
  if (S.es) { try { S.es.close(); } catch {} S.es = null; }
  const es = new EventSource(`/api/events?token=${encodeURIComponent(S.sseToken)}`);
  S.es = es;
  es.addEventListener('connected', () => setLiveStatus(true, 'Live SSE'));
  es.addEventListener('mail:new', (ev) => {
    try {
      const payload = JSON.parse(ev.data || '{}');
      const m = payload.message;
      if (m) {
        S.msgs = [m, ...S.msgs.filter((x) => x.id !== m.id)];
        S.unread = payload.unread ?? S.unread + 1;
        if (payload.stats) S.stats = payload.stats;
        updateUnreadBadge();
        if (S.tab === 'inbox') renderView();
        if (!payload.silent && m.otp) triggerOtpArrival(m);
        else if (!payload.silent) {
          playChime('mail');
          toast(`📩 ${m.service?.name || 'New Mail'}: ${(m.subject || '').slice(0, 32)}`);
        }
      }
    } catch {}
  });
  es.addEventListener('mail:sync', () => refreshMessages(false));
  es.addEventListener('addresses:changed', () => loadAddresses());
  es.addEventListener('totp:changed', () => loadTotp());
  es.addEventListener('gmail:sync', () => loadGmails());
  es.addEventListener('auto2fa:update', (ev) => {
    try {
      S.auto2fa = JSON.parse(ev.data || 'null');
      if (S.tab === 'hub' && S.hubSub === 'auto2fa') renderView();
    } catch {}
  });
  es.addEventListener('domain:changed', (ev) => {
    try {
      const d = JSON.parse(ev.data || '{}');
      if (typeof d.prefDomain === 'number') S.prefDomain = d.prefDomain;
      if (S.tab === 'inbox') renderView();
    } catch {}
  });
  es.onerror = () => {
    setLiveStatus(false, 'Reconnecting');
  };
}

// Gentle fallback sync ONLY if SSE drops
setInterval(() => {
  if (document.visibilityState === 'visible' && !S.sseReady && INIT_DATA) {
    refreshMessages(false);
  }
}, 14000);

// ---------- API Loaders ----------
function updateUnreadBadge() {
  const b = $('#navUnread');
  if (!b) return;
  if (S.unread > 0) {
    b.hidden = false;
    b.textContent = S.unread > 99 ? '99+' : String(S.unread);
  } else {
    b.hidden = true;
  }
}

async function refreshMessages(showSpinner = false) {
  if (showSpinner) $('#btnTopRefresh')?.classList.add('active');
  try {
    const qs = new URLSearchParams({
      limit: '80',
      filter: S.mailFilter,
      ...(S.mailQuery ? { q: S.mailQuery } : {}),
      ...(S.selectedAddr ? { addr: S.selectedAddr } : {}),
    });
    const d = await api(`messages?${qs.toString()}`);
    const prevTopId = S.msgs[0]?.id;
    S.msgs = d.messages || [];
    S.unread = d.unread || 0;
    if (d.stats) S.stats = d.stats;
    updateUnreadBadge();
    if (S.tab === 'inbox') renderView();
    const newest = S.msgs[0];
    if (newest && newest.id !== prevTopId && !newest.read && newest.otp && (Date.now() - newest.date) < 120000) {
      triggerOtpArrival(newest);
    }
  } catch {}
  if (showSpinner) $('#btnTopRefresh')?.classList.remove('active');
}

async function loadAddresses() {
  try {
    const d = await api('addresses');
    S.addrs = d.addresses || [];
    persistLocalVaults();
    if (S.tab === 'inbox' || (S.tab === 'hub' && S.hubSub === 'addrs')) renderView();
  } catch {}
}

async function loadTotp() {
  try {
    const d = await api('totp');
    S.totp = d.items || [];
    persistLocalVaults();
    await precomputeTotpCodes();
    if (S.tab === 'totp') renderView();
  } catch {}
}

async function precomputeTotpCodes() {
  const now = Date.now();
  await Promise.all(S.totp.map(async (t) => {
    const live = await computeTotpAsync(t.secret, now, { algo: t.algo, digits: t.digits, period: t.period });
    t.code = live.code;
    t.nextCode = live.nextCode;
    t.remaining = live.remaining;
  }));
}

async function loadGmails() {
  try {
    const d = await api('gmail');
    S.gmails = d.accounts || [];
    S.gmailEnabled = Boolean(d.enabled);
    persistLocalVaults();
    if (S.tab === 'inbox' || S.tab === 'hub') renderView();
  } catch {}
}

async function loadAdmin() {
  if (!S.user?.admin) return;
  try {
    S.adminData = await api('admin/stats');
    if (S.tab === 'admin') renderView();
  } catch {}
}

// ---------- High-FPS 2FA Vault Ticker ----------
function tickTotpDom() {
  if (S.tab !== 'totp' || !S.totp.length) return;
  const now = Date.now();
  const r = 13;
  const circ = 2 * Math.PI * r;
  for (const t of S.totp) {
    const card = document.querySelector(`[data-totp-id="${t.id}"]`);
    if (!card) continue;
    const sync = getCachedTotpSync(t.secret, now, { algo: t.algo, digits: t.digits, period: t.period });
    if (!sync.code) {
      computeTotpAsync(t.secret, now, { algo: t.algo, digits: t.digits, period: t.period }).then((live) => {
        t.code = live.code;
        t.nextCode = live.nextCode;
      });
    }
    const codeEl = card.querySelector('.totp-code');
    const nextEl = card.querySelector('.totp-next');
    const ringFg = card.querySelector('.ring-fg');
    const ringNum = card.querySelector('.ring-num');
    const codeVal = sync.code || t.code || '------';
    const nextVal = sync.nextCode || t.nextCode || '';
    if (codeEl && card.dataset.code !== codeVal) {
      card.dataset.code = codeVal;
      codeEl.textContent = formatCode(codeVal);
    }
    if (nextEl) {
      nextEl.textContent = nextVal ? `Next ${formatCode(nextVal)}` : '';
      nextEl.classList.toggle('show', sync.remaining <= 10);
    }
    if (ringFg) {
      const frac = Math.max(0, Math.min(1, sync.remainingExact / sync.period));
      ringFg.style.strokeDasharray = String(circ);
      ringFg.style.strokeDashoffset = String(circ * (1 - frac));
      ringFg.classList.toggle('warn', sync.remaining <= 7 && sync.remaining > 3);
      ringFg.classList.toggle('danger', sync.remaining <= 3);
    }
    if (ringNum) ringNum.textContent = String(sync.remaining);
  }
}
setInterval(tickTotpDom, 200);

// ---------- Navigation & View Renderers ----------
function updateNavPill() {
  const nav = $('#bottomNav');
  const pill = $('#navPill');
  if (!nav || !pill || nav.hidden) return;
  const on = nav.querySelector('.nav-item.on');
  if (!on || on.offsetWidth === 0) { pill.classList.remove('ready'); return; }
  pill.style.width = `${on.offsetWidth}px`;
  pill.style.transform = `translateX(${on.offsetLeft}px)`;
  pill.classList.add('ready');
}
window.addEventListener('resize', () => requestAnimationFrame(updateNavPill));

function setTab(tab) {
  if (tab === 'admin' && !S.user?.admin) tab = 'inbox';
  S.tab = tab;
  $$('.nav-item').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  requestAnimationFrame(updateNavPill);
  renderView();
  if (tab === 'totp') loadTotp();
  if (tab === 'hub') {
    if (S.hubSub === 'addrs') loadAddresses();
    if (S.hubSub === 'gmail') loadGmails();
    if (S.hubSub === 'auto2fa') api('gmail/auto2fa').then((d) => { S.auto2fa = d.job; renderView(); }).catch(() => {});
  }
  if (tab === 'admin') loadAdmin();
}

function renderView() {
  const root = $('#viewRoot');
  if (!root) return;
  const active = document.activeElement;
  const focusId = active && active.id && root.contains(active) ? active.id : null;
  const selStart = focusId && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  const selEnd = focusId && typeof active.selectionEnd === 'number' ? active.selectionEnd : null;

  if (S.tab === 'inbox') root.innerHTML = renderInbox();
  else if (S.tab === 'totp') { root.innerHTML = renderTotpVault(); tickTotpDom(); }
  else if (S.tab === 'hub') root.innerHTML = renderHub();
  else if (S.tab === 'settings') root.innerHTML = renderSettings();
  else if (S.tab === 'admin') root.innerHTML = renderAdmin();

  if (focusId) {
    const next = document.getElementById(focusId);
    if (next) {
      next.focus({ preventScroll: true });
      if (selStart !== null && typeof next.setSelectionRange === 'function') {
        try { next.setSelectionRange(selStart, selEnd ?? selStart); } catch {}
      }
    }
  }
}

function renderInbox() {
  const act = activeTempAddr();
  const activeAddrStr = S.selectedAddr || act?.addr || '';
  const domModeLabel = S.prefDomain === -1 ? 'Auto-Random' : (S.domains[S.prefDomain] || S.domains[0]);

  const switcherItems = [
    { addr: '', label: `সব ইনবক্স (${S.stats.total || S.msgs.length})` },
    ...S.addrs.filter((a) => !a.expired).slice(0, 6).map((a) => ({ addr: a.addr, label: a.label ? `${a.label} · ${a.addr.split('@')[0]}` : a.addr })),
    ...S.gmails.map((g) => ({ addr: g.email, label: g.email })),
  ];

  const chips = [
    { id: 'all', l: 'সব' },
    { id: 'unread', l: `অপঠিত${S.unread ? ` (${S.unread})` : ''}` },
    { id: 'otp', l: 'OTP কোড' },
    { id: 'link', l: 'ভেরিফাই লিংক' },
    { id: 'pinned', l: 'পিন করা' },
  ];

  const rowsHtml = S.msgs.length
    ? S.msgs.map((m) => {
        const brand = detectBrand(m.service?.name || m.from || '', '');
        const otpFmt = m.otp ? (S.settings.otpFormat === 'spaced' ? formatCode(m.otp) : m.otp) : '';
        return `
        <div class="mail-row ${m.read ? '' : 'unread'}" data-act="openMail" data-id="${esc(m.id)}">
          <div class="svc-avatar" style="background:${brand.color}22;color:${brand.color};border:1px solid ${brand.color}40">${esc(brand.mono)}</div>
          <div class="mail-body">
            <div class="mail-top">
              <div class="mail-sender">
                ${m.read ? '' : '<i class="unread-dot"></i>'}
                ${m.pinned ? ic('star', 'ic-sm') : ''}
                <span>${esc(m.service?.name || m.from || 'Sender')}</span>
              </div>
              <span class="mail-time">${esc(relTime(m.date))}</span>
            </div>
            <div class="mail-subj">${esc(m.subject || m.purpose || '(No subject)')}</div>
            <div class="mail-foot">
              <span class="mail-to">${esc(m.to)}</span>
              ${otpFmt ? `<button type="button" class="otp-pill" data-act="copyMsgOtp" data-v="${esc(m.otp)}" data-id="${esc(m.id)}">${ic('key', 'ic-sm')}<span>${esc(otpFmt)}</span></button>` : ''}
            </div>
          </div>
        </div>`;
      }).join('')
    : `<div class="empty">
        <div class="empty-icon">${ic('inbox', 'ic-lg')}</div>
        <h3>ইনবক্স খালি</h3>
        <p>${S.selectedAddr ? `${esc(S.selectedAddr)}-এ এখনো কোনো মেইল আসেনি` : 'উপরের ঠিকানাটি কপি করে কোনো সাইটে ব্যবহার করুন — OTP সাথে সাথে এখানে চলে আসবে।'}</p>
        <div class="row" style="justify-content:center">
          <button type="button" class="btn primary sm" data-act="quickGen">${ic('bolt', 'ic-sm')}<span>নতুন মেইল</span></button>
          <button type="button" class="btn sm" data-act="testmail">${ic('shield', 'ic-sm')}<span>টেস্ট OTP</span></button>
        </div>
      </div>`;

  return `
  <section class="view">
    <div class="card identity-card">
      <div class="identity-meta">
        <div class="row" style="gap:6px">
          <span class="badge accent">${ic('globe', 'ic-sm')}<span>${esc(domModeLabel)}</span></span>
          <button type="button" class="badge" data-act="openDomainPicker">ডোমেইন বদল</button>
        </div>
        <span class="badge ${act?.expiresAt ? 'warn' : 'ok'}">${esc(fmtTtl(act))}</span>
      </div>

      <button type="button" class="addr-tapbox" id="heroCopyBtn" data-act="copyHero" data-v="${esc(activeAddrStr)}">
        <code>${esc(activeAddrStr || 'ট্যাপ করে নতুন মেইল তৈরি করুন')}</code>
        <span class="copy-hint">${ic('copy', 'ic-sm')}<span>কপি</span></span>
      </button>

      <div class="hero-actions">
        <button type="button" class="btn primary" data-act="quickGen">${ic('refresh', 'ic-sm')}<span>নতুন মেইল</span></button>
        <button type="button" class="btn" data-act="openCustomSheet">${ic('edit', 'ic-sm')}<span>কাস্টম</span></button>
        <button type="button" class="btn" data-act="openQrSheet" data-v="${esc(activeAddrStr)}" aria-label="QR Code">${ic('qr')}</button>
      </div>
    </div>

    <div class="chip-bar">
      ${switcherItems.map((it) => `<button type="button" class="chip ${S.selectedAddr === it.addr ? 'on' : ''}" data-act="selectAddrFilter" data-v="${esc(it.addr)}">${esc(it.label)}</button>`).join('')}
    </div>

    <div class="row">
      <div class="search-wrap" style="flex:1">
        ${ic('search', 'ic-sm')}
        <input id="mailSearchInput" type="search" placeholder="সার্চ: OTP, সার্ভিস, ঠিকানা…" value="${esc(S.mailQuery)}">
        ${S.mailQuery ? `<button type="button" data-act="clearMailSearch">${ic('x', 'ic-sm')}</button>` : ''}
      </div>
      <button type="button" class="icon-btn" data-act="markAllRead" title="সব পঠিত">${ic('check', 'ic-sm')}</button>
    </div>

    <div class="chip-bar">
      ${chips.map((c) => `<button type="button" class="chip ok ${S.mailFilter === c.id ? 'on' : ''}" data-act="setMailFilter" data-f="${c.id}">${c.l}</button>`).join('')}
    </div>

    <div class="mail-list" id="mailList">${rowsHtml}</div>
  </section>`;
}

function renderTotpVault() {
  const cats = ['all', 'pinned', ...new Set(S.totp.map((t) => t.category).filter((c) => c && c !== 'General'))];
  const q = S.totpQuery.trim().toLowerCase();
  const filtered = S.totp.filter((t) => {
    if (S.totpCat === 'pinned' && !t.pinned) return false;
    if (S.totpCat !== 'all' && S.totpCat !== 'pinned' && t.category !== S.totpCat) return false;
    if (q && !`${t.name} ${t.issuer || ''} ${t.category || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const cardsHtml = filtered.length
    ? filtered.map((t) => {
        const b = detectBrand(t.name, t.issuer);
        return `
        <div class="totp-card" data-totp-id="${esc(t.id)}" data-code="${esc(t.code || '')}" data-act="copyTotpCard">
          <div class="totp-top">
            <div class="totp-ident">
              <div class="svc-avatar" style="background:${b.color}22;color:${b.color};border:1px solid ${b.color}40">${esc(b.mono)}</div>
              <div class="totp-info">
                <div class="totp-name">${esc(t.name)}</div>
                <div class="totp-sub">
                  <span>${esc(t.issuer || t.category || 'Authenticator')}</span>
                  <span>•</span>
                  <span>${t.digits || 6}d · ${t.period || 30}s</span>
                </div>
              </div>
            </div>
            <div class="totp-actions">
              <button type="button" class="icon-btn ${t.pinned ? 'active' : ''}" data-act="pinTotp" data-id="${esc(t.id)}" data-p="${t.pinned ? '0' : '1'}" title="Pin">${ic('star', 'ic-sm')}</button>
              <button type="button" class="icon-btn" data-act="openTotpDetail" data-id="${esc(t.id)}" title="Manage">${ic('qr', 'ic-sm')}</button>
            </div>
          </div>
          <div class="totp-bottom">
            <div class="totp-code-wrap">
              <div class="totp-code">${esc(formatCode(t.code || '------'))}</div>
              <div class="totp-next">Next ${esc(formatCode(t.nextCode || ''))}</div>
            </div>
            <div class="ring-wrap">
              <svg viewBox="0 0 34 34"><circle class="ring-bg" cx="17" cy="17" r="13"/><circle class="ring-fg" cx="17" cy="17" r="13"/></svg>
              <span class="ring-num">${t.remaining || 30}</span>
            </div>
          </div>
        </div>`;
      }).join('')
    : `<div class="empty">
        <div class="empty-icon">${ic('shield', 'ic-lg')}</div>
        <h3>2FA ভল্ট খালি</h3>
        <p>QR কোড স্ক্যান করুন অথবা যেকোনো Secret Key / otpauth URI যোগ করে লাইভ কোড পান।</p>
        <button type="button" class="btn primary sm" data-act="openAddTotpSheet">${ic('plus', 'ic-sm')}<span>নতুন 2FA যোগ করুন</span></button>
      </div>`;

  return `
  <section class="view">
    <div class="row-between">
      <div>
        <strong style="font-size:16px">2FA Authenticator Vault</strong>
        <div class="muted">${S.totp.length}টি সুরক্ষিত অ্যাকাউন্ট • ট্যাপ করলেই কপি</div>
      </div>
      <div class="row" style="gap:6px">
        <button type="button" class="btn sm" data-act="openBackupSheet" title="Backup">${ic('download', 'ic-sm')}</button>
        <button type="button" class="btn sm primary" data-act="openAddTotpSheet">${ic('plus', 'ic-sm')}<span>যোগ করুন</span></button>
      </div>
    </div>

    <div class="search-wrap">
      ${ic('search', 'ic-sm')}
      <input id="totpSearchInput" type="search" placeholder="2FA অ্যাকাউন্ট খুঁজুন…" value="${esc(S.totpQuery)}">
    </div>

    <div class="chip-bar">
      ${cats.map((c) => `<button type="button" class="chip ${S.totpCat === c ? 'on' : ''}" data-act="setTotpCat" data-c="${esc(c)}">${c === 'all' ? 'সবগুলো' : c === 'pinned' ? '★ পিন করা' : esc(c)}</button>`).join('')}
    </div>

    <div class="totp-list" id="totpList">${cardsHtml}</div>
  </section>`;
}

function renderHub() {
  const subs = [
    { id: 'addrs', l: `অ্যাড্রেস (${S.addrs.length})` },
    { id: 'gmail', l: `Gmail (${S.gmails.length})` },
    { id: 'auto2fa', l: 'Auto-2FA বট' },
  ];
  let body = '';
  if (S.hubSub === 'addrs') body = renderHubAddrs();
  else if (S.hubSub === 'gmail') body = renderHubGmail();
  else body = renderHubAuto2fa();

  return `
  <section class="view">
    <div class="seg">
      ${subs.map((x) => `<button type="button" class="${S.hubSub === x.id ? 'on' : ''}" data-act="setHubSub" data-s="${x.id}">${x.l}</button>`).join('')}
    </div>
    ${body}
  </section>`;
}

function renderHubAddrs() {
  const plusHint = S.gmails[0]?.email
    ? `<div class="card row-between">
        <div style="min-width:0">
          <strong style="font-size:13px">Gmail +Alias জেনারেটর</strong>
          <div class="muted" style="overflow:hidden;text-overflow:ellipsis">${esc(S.gmails[0].email)} থেকে আনলিমিটেড অ্যালিয়াস</div>
        </div>
        <button type="button" class="btn sm primary" data-act="genPlusAlias" data-email="${esc(S.gmails[0].email)}">তৈরি ও কপি</button>
      </div>`
    : '';

  const list = S.addrs.length
    ? S.addrs.map((a) => `
      <div class="card stack" style="gap:8px">
        <div class="row-between">
          <div style="min-width:0;flex:1">
            <div class="row" style="gap:6px">
              ${a.pinned ? `<span class="badge accent">★ Pin</span>` : ''}
              ${a.label ? `<span class="badge">${esc(a.label)}</span>` : ''}
              <span class="badge ${a.expired ? 'danger' : 'ok'}">${esc(fmtTtl(a))}</span>
            </div>
            <div class="mono" style="font-size:13.5px;font-weight:600;margin-top:5px;word-break:break-all">${esc(a.addr)}</div>
            <div class="muted">${a.count || 0}টি মেসেজ</div>
          </div>
          <div class="row" style="gap:5px;flex-shrink:0">
            <button type="button" class="icon-btn" data-act="copyRaw" data-v="${esc(a.addr)}" title="Copy">${ic('copy', 'ic-sm')}</button>
            <button type="button" class="icon-btn ${a.pinned ? 'active' : ''}" data-act="pinAddr" data-id="${esc(a.id)}" data-p="${a.pinned ? '0' : '1'}" title="Pin">${ic('star', 'ic-sm')}</button>
          </div>
        </div>
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <button type="button" class="btn sm" data-act="selectAddrFilter" data-v="${esc(a.addr)}" data-go="inbox">ইনবক্স দেখুন</button>
          <button type="button" class="btn sm" data-act="extendAddr" data-id="${esc(a.id)}">+1h মেয়াদ</button>
          <button type="button" class="btn sm" data-act="editAddrLabel" data-id="${esc(a.id)}" data-l="${esc(a.label || '')}">লেবেল</button>
          <button type="button" class="btn sm danger" data-act="delAddr" data-id="${esc(a.id)}">ডিলিট</button>
        </div>
      </div>`).join('')
    : `<div class="empty"><h3>কোনো ঠিকানা নেই</h3><p>দ্রুত ইনবক্সের জন্য নতুন ঠিকানা তৈরি করুন।</p><button type="button" class="btn primary sm" data-act="quickGen">নতুন মেইল</button></div>`;

  return `
  ${plusHint}
  <div class="row-between">
    <strong style="font-size:14px">অ্যাক্টিভ ঠিকানা সমূহ</strong>
    <button type="button" class="btn sm primary" data-act="openCustomSheet">${ic('plus', 'ic-sm')}<span>নতুন কাস্টম</span></button>
  </div>
  <div class="stack">${list}</div>`;
}

function renderHubGmail() {
  const listHtml = S.gmails.length
    ? S.gmails.map((g) => `
      <div class="card row-between">
        <div style="min-width:0;flex:1">
          <div class="row" style="gap:6px">
            <span class="badge ${g.status === 'expired' ? 'warn' : 'ok'}">${g.status === 'expired' ? 'মেয়াদ শেষ' : 'লাইভ সিঙ্ক'}</span>
            ${g.twoFaEnabled ? '<span class="badge accent">2FA Active</span>' : ''}
          </div>
          <div class="mono" style="font-size:13px;font-weight:600;margin-top:4px;overflow:hidden;text-overflow:ellipsis">${esc(g.email)}</div>
          ${g.lastError ? `<div style="font-size:11px;color:var(--danger);margin-top:2px">${esc(g.lastError)}</div>` : ''}
        </div>
        <div class="row" style="gap:5px">
          <button type="button" class="icon-btn" data-act="selectAddrFilter" data-v="${esc(g.email)}" data-go="inbox" title="ইনবক্স">${ic('inbox', 'ic-sm')}</button>
          <button type="button" class="icon-btn danger" data-act="delGmail" data-email="${esc(g.email)}" title="Remove">${ic('trash', 'ic-sm')}</button>
        </div>
      </div>`).join('')
    : '<div class="card muted">কোনো Gmail অ্যাকাউন্ট যুক্ত নেই। নিচ থেকে এক ক্লিকে কানেক্ট করুন।</div>';

  return `
  <div class="card stack">
    <div class="row-between">
      <div>
        <strong style="font-size:14.5px">Gmail লাইভ OTP সিঙ্ক</strong>
        <div class="muted">ইনবক্স থেকে OTP ও লিংক অটোমেটিক নিয়ে আসবে</div>
      </div>
      <button type="button" class="btn sm" data-act="syncGmailNow">${ic('refresh', 'ic-sm')}<span>Sync</span></button>
    </div>
    ${S.gmailEnabled
      ? `<button type="button" class="btn primary full" data-act="connectGmailOAuth">${ic('link', 'ic-sm')}<span>Google অ্যাকাউন্ট দিয়ে যুক্ত করুন</span></button>`
      : `<div class="badge warn" style="height:auto;padding:8px 10px">OAuth কনফিগার করা নেই — App Password দিয়ে সরাসরি যুক্ত করা যাবে</div>`}
  </div>

  <div class="card stack">
    <strong style="font-size:13.5px">App Password দিয়ে Gmail যুক্ত করুন</strong>
    <div class="field"><label>Gmail ঠিকানা</label><input id="gmAppEmail" class="input" type="email" placeholder="example@gmail.com"></div>
    <div class="field"><label>১৬-অক্ষরের App Password</label><input id="gmAppPass" class="input mono" type="password" placeholder="xxxx xxxx xxxx xxxx"></div>
    <button type="button" class="btn primary" data-act="connectGmailAppPass">কানেক্ট করুন</button>
  </div>

  <div class="stack">${listHtml}</div>`;
}

function renderHubAuto2fa() {
  const j = S.auto2fa;
  const step = j?.step || 0;
  const steps = ['লগইন', 'ভেরিফাই', 'Key এক্সট্র্যাক্ট', 'সক্রিয়'];
  const statusCard = j
    ? `<div class="card stack">
        <div class="row-between">
          <strong style="font-size:13.5px">${esc(j.email)}</strong>
          <span class="badge ${j.status === 'completed' ? 'ok' : j.status === 'failed' ? 'warn' : 'accent'}">${esc(j.status)}</span>
        </div>
        <div class="stepper">
          ${steps.map((s, idx) => `<div class="step-item ${step > idx + 1 ? 'done' : step === idx + 1 ? 'active' : ''}">${idx + 1}. ${s}</div>`).join('')}
        </div>
        ${j.stepTitle ? `<div class="muted">${esc(j.stepTitle)}</div>` : ''}
        ${j.promptNumber ? `<div class="card" style="text-align:center;background:var(--accent-soft);border-color:var(--accent-border)"><div class="muted">ফোনে Google প্রম্পটে চাপুন:</div><strong style="font-size:28px" class="mono">${esc(j.promptNumber)}</strong></div>` : ''}
        ${j.screenshot ? `<img src="${j.screenshot}" alt="Live screen" style="width:100%;border-radius:10px;border:1px solid var(--border)">` : ''}
        ${j.options?.length ? `<div class="stack">${j.options.map((o) => `<button type="button" class="btn sm full" data-act="a2faOpt" data-id="${esc(j.id)}" data-idx="${o.idx}">${esc(o.text)}</button>`).join('')}</div>` : ''}
        ${(j.status === 'waiting_code' || j.status === 'waiting_captcha' || j.status === 'waiting_approval') ? `
          <div class="row">
            <input id="a2faChallengeInput" class="input" placeholder="কোড বা ভেরিফিকেশন তথ্য লিখুন…">
            <button type="button" class="btn primary" data-act="a2faSendInput" data-id="${esc(j.id)}">পাঠান</button>
          </div>
          <div class="row">
            <button type="button" class="btn sm" style="flex:1" data-act="a2faAction" data-a="continue" data-id="${esc(j.id)}">পরবর্তী ধাপ</button>
            <button type="button" class="btn sm" data-act="a2faAction" data-a="alt" data-id="${esc(j.id)}">অন্য উপায়</button>
            <button type="button" class="btn sm danger" data-act="a2faAction" data-a="stop" data-id="${esc(j.id)}">বন্ধ</button>
          </div>` : ''}
        ${j.totpCode ? `<div class="card row-between" style="border-color:var(--ok)"><div><div class="muted">লাইভ কোড সেভ হয়েছে</div><div class="mono" style="font-size:22px;font-weight:700">${esc(formatCode(j.totpCode))}</div></div><button type="button" class="btn ok sm" data-act="copyRaw" data-v="${esc(j.totpCode)}">কপি</button></div>` : ''}
      </div>`
    : '';

  return `
  ${statusCard}
  <div class="card stack">
    <div>
      <strong style="font-size:14.5px">Auto Google 2FA সেটআপ ইঞ্জিন</strong>
      <div class="muted">স্বয়ংক্রিয়ভাবে Google অ্যাকাউন্টে ঢুকে 2FA চালু ও Secret Key আপনার ভল্টে সেভ করবে</div>
    </div>
    <div class="field"><label>Gmail ঠিকানা</label><input id="a2faEmail" class="input" type="email" placeholder="example@gmail.com"></div>
    <div class="field"><label>পাসওয়ার্ড (অথবা সরাসরি 2FA Setup Key)</label><input id="a2faPass" class="input" type="password" placeholder="Gmail password বা JBSW… Key"></div>
    <div class="field"><label>রিকভারি ইমেইল (ঐচ্ছিক)</label><input id="a2faRec" class="input" type="email" placeholder="recovery@gmail.com"></div>
    <button type="button" class="btn primary full" data-act="startAuto2fa">${ic('bolt', 'ic-sm')}<span>অটো 2FA চালু করুন</span></button>
  </div>`;
}

function renderSettings() {
  const s = S.settings;
  const themes = [
    { id: 'aurora', l: 'Aurora', c: 'linear-gradient(135deg,#6d4aff,#00c2ff)' },
    { id: 'claude', l: 'Claude Orange', c: 'linear-gradient(135deg,#d97757,#f09e7c)' },
    { id: 'claude-light', l: 'Claude Cream', c: 'linear-gradient(135deg,#f5f2eb,#cc5d38)' },
    { id: 'midnight', l: 'Midnight', c: 'linear-gradient(135deg,#6366f1,#38bdf8)' },
    { id: 'obsidian', l: 'Obsidian Gold', c: 'linear-gradient(135deg,#0b0c10,#f5b942)' },
    { id: 'ocean', l: 'Ocean', c: 'linear-gradient(135deg,#1d4ed8,#22d3ee)' },
    { id: 'cobalt', l: 'Cobalt', c: 'linear-gradient(135deg,#2563eb,#60a5fa)' },
    { id: 'emerald', l: 'Emerald', c: 'linear-gradient(135deg,#10b981,#a3e635)' },
    { id: 'amber', l: 'Solar Amber', c: 'linear-gradient(135deg,#f59e0b,#fb7185)' },
    { id: 'crimson', l: 'Crimson', c: 'linear-gradient(135deg,#f43f5e,#fb923c)' },
    { id: 'cyber', l: 'Cyber Neon', c: 'linear-gradient(135deg,#00e5ff,#ff2bd6)' },
    { id: 'nebula', l: 'Nebula', c: 'linear-gradient(135deg,#a855f7,#f472b6)' },
    { id: 'nord', l: 'Nord Arctic', c: 'linear-gradient(135deg,#5e81ac,#88c0d0)' },
    { id: 'daylight', l: 'Daylight', c: 'linear-gradient(135deg,#ffffff,#2563eb)' },
    { id: 'sky', l: 'Sky Frost', c: 'linear-gradient(135deg,#eaf5ff,#0284c7)' },
    { id: 'mint', l: 'Mint Leaf', c: 'linear-gradient(135deg,#eefaf4,#059669)' },
    { id: 'blush', l: 'Blush Rose', c: 'linear-gradient(135deg,#fff2f6,#db2777)' },
    { id: 'auto', l: 'Telegram Auto', c: 'conic-gradient(#6d4aff,#00c2ff,#f5f2eb,#d97757,#6d4aff)' },
  ];
  const skins = [
    { id: 'glass', l: 'iPhone Glass', pv: 'pv-glass' },
    { id: 'claude', l: 'Claude Studio', pv: 'pv-claude' },
    { id: 'mix', l: 'Glass × Claude', pv: 'pv-mix' },
    { id: 'bento', l: 'Spatial Bento', pv: 'pv-bento' },
    { id: 'obsidian', l: 'OLED Craft', pv: 'pv-obsidian' },
    { id: 'minimal', l: 'Minimal', pv: 'pv-minimal' },
  ];
  const toggle = (key, title, desc, val) => `
    <div class="toggle-row">
      <div class="toggle-info"><strong>${title}</strong><small>${desc}</small></div>
      <button type="button" class="switch ${val ? 'on' : ''}" data-act="toggleSetting" data-k="${key}" aria-pressed="${Boolean(val)}"></button>
    </div>`;

  return `
  <section class="view">
    <div class="card stack">
      <div class="row-between">
        <strong style="font-size:14px">ডিজাইন স্কিন (UI Style)</strong>
        <span class="badge accent">${esc(skins.find((x) => x.id === s.skin)?.l || s.skin)}</span>
      </div>
      <div class="skin-grid">
        ${skins.map((sk) => `
          <button type="button" class="skin-card ${s.skin === sk.id ? 'on' : ''}" data-act="setSkin" data-v="${sk.id}">
            <div class="skin-pv ${sk.pv}"><u></u><u></u></div>
            <span>${sk.l}</span>
          </button>`).join('')}
      </div>
    </div>

    <div class="card stack">
      <div class="row-between">
        <strong style="font-size:14px">কালার থিম (${themes.length})</strong>
        <span class="badge">${esc(themes.find((x) => x.id === s.theme)?.l || s.theme)}</span>
      </div>
      <div class="theme-grid">
        ${themes.map((t) => `
          <button type="button" class="swatch-btn ${s.theme === t.id ? 'on' : ''}" data-act="setTheme" data-v="${t.id}">
            <span class="swatch-dot" style="background:${t.c}"></span>
            <span>${t.l}</span>
          </button>`).join('')}
      </div>
    </div>

    <div class="card">
      ${toggle('autoCopy', 'স্মার্ট অটো-কপি OTP', 'নতুন কোড এলেই অটোমেটিক কীবোর্ডে কপি করবে', s.autoCopy)}
      ${toggle('autoMarkReadOnCopy', 'কপিতে অটো-পঠিত', 'OTP কপি করলে মেইল পঠিত হিসেবে চিহ্নিত হবে', s.autoMarkReadOnCopy)}
      ${toggle('sound', 'সাউন্ড ও হ্যাপটিক ফিডব্যাক', 'নতুন কোড ও বাটন ট্যাপে সূক্ষ্ম ভাইব্রেশন ও চিম সাউন্ড', s.sound)}
      ${toggle('notify', 'টেলিগ্রাম বট নোটিফিকেশন', 'ইনকামিং মেইল চ্যাটেও সাথে সাথে পাঠাবে', s.notify)}
      ${toggle('otpOnly', 'শুধু OTP ও ভেরিফাই মেইল', 'অপ্রয়োজনীয় নিউজলেটার নোটিফিকেশন ফিল্টার করবে', s.otpOnly)}
      ${toggle('compact', 'কম্প্যাক্ট ডেনসিটি', 'এক স্ক্রিনে আরও বেশি মেইল ও 2FA কার্ড দেখাবে', s.compact)}
      ${toggle('liteBlur', 'পারফরম্যান্স মোড (হালকা ব্লার)', 'পুরোনো ফোনে ১২০Hz আল্ট্রা-স্মুদ স্ক্রল ও ব্যাটারি সেভ', s.liteBlur)}
    </div>

    <div class="card stack">
      <strong style="font-size:14px">ভল্ট ব্যাকআপ ও পুনরুদ্ধার</strong>
      <div class="muted">সার্ভার রিস্টার্ট হলেও আপনার সব অ্যাড্রেস, 2FA কী এবং সেটিংস নিরাপদে রাখুন।</div>
      <div class="row">
        <button type="button" class="btn primary" style="flex:1" data-act="openBackupSheet">${ic('download', 'ic-sm')}<span>ব্যাকআপ / রিস্টোর</span></button>
        <button type="button" class="btn danger" data-act="clearInboxConfirm">${ic('trash', 'ic-sm')}<span>ইনবক্স ক্লিয়ার</span></button>
      </div>
    </div>
  </section>`;
}

function renderAdmin() {
  const a = S.adminData;
  if (!a) return `<section class="view"><div class="card muted">অ্যাডমিন ডেটা লোড হচ্ছে…</div></section>`;
  const act = a.activity || [];
  const max = Math.max(1, ...act);
  const bars = act.map((v, i) => {
    const h = Math.max(4, Math.round((v / max) * 34));
    return `<rect x="${i * 10}" y="${38 - h}" width="6" height="${h}" rx="2" fill="var(--accent)" opacity="${v ? 0.9 : 0.2}"/>`;
  }).join('');

  return `
  <section class="view">
    <div class="kpi-grid">
      <div class="kpi"><small>মোট ইউজার</small><strong>${a.stats.users}</strong></div>
      <div class="kpi"><small>আজকের মেইল</small><strong>${a.stats.today}</strong></div>
      <div class="kpi"><small>অ্যাক্টিভ ঠিকানা</small><strong>${a.stats.addresses}</strong></div>
      <div class="kpi"><small>লাইভ SSE সেশন</small><strong>${a.sse?.clients || 0}</strong></div>
    </div>

    <div class="card stack">
      <div class="row-between">
        <strong style="font-size:13.5px">২৪ ঘণ্টার ট্রাফিক ও সিস্টেম</strong>
        <span class="badge ok">${a.titan.online}/${a.titan.total} IMAP Online</span>
      </div>
      <svg viewBox="0 0 ${Math.max(240, act.length * 10)} 40" style="width:100%;height:42px">${bars}</svg>
      <div class="muted">RAM ${a.system.rss} MB • Uptime ${Math.floor(a.system.uptime / 60)}m • ${esc(a.system.node)}</div>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <button type="button" class="btn sm ${a.openAccess ? 'danger' : 'ok'}" data-act="admToggleAccess" data-open="${a.openAccess ? '0' : '1'}">${a.openAccess ? 'Approval Mode চালু' : 'Open Access চালু'}</button>
        <button type="button" class="btn sm" data-act="admSweep">মেয়াদোত্তীর্ণ ক্লিন (Sweep)</button>
      </div>
    </div>

    <div class="card stack">
      <strong style="font-size:13.5px">ব্রডকাস্ট ঘোষণা</strong>
      <div class="row">
        <input id="admBcInput" class="input" placeholder="সব ইউজারকে মেসেজ পাঠান…">
        <button type="button" class="btn primary sm" data-act="admBroadcast">পাঠান</button>
      </div>
    </div>

    <div class="card stack">
      <strong style="font-size:13.5px">ইউজার ডিরেক্টরি (${a.users.length})</strong>
      <div class="stack">
        ${a.users.slice(0, 20).map((u) => `
          <div class="row-between" style="padding:6px 0;border-bottom:1px solid var(--border)">
            <div style="min-width:0">
              <strong style="font-size:13px">${esc(u.name)}</strong>
              <div class="muted">${esc(u.status)} • ${u.addresses} addr • ${u.messages} msg</div>
            </div>
            <div class="row" style="gap:4px">
              ${u.status !== 'approved' ? `<button type="button" class="btn sm ok" data-act="admUser" data-id="${esc(u.id)}" data-ua="approve">✓</button>` : ''}
              ${u.status !== 'banned' ? `<button type="button" class="btn sm danger" data-act="admUser" data-id="${esc(u.id)}" data-ua="ban">Ban</button>` : `<button type="button" class="btn sm" data-act="admUser" data-id="${esc(u.id)}" data-ua="unban">Unban</button>`}
            </div>
          </div>`).join('')}
      </div>
    </div>
  </section>`;
}

// ---------- Modal Bottom Sheets ----------
function openSheet(html) {
  const root = $('#sheetRoot');
  if (!root) return;
  root.innerHTML = `<div class="sheet-backdrop" data-act="closeSheetBackdrop"><div class="sheet" role="dialog"><div class="sheet-handle"></div>${html}</div></div>`;
}
function closeSheet() {
  const root = $('#sheetRoot');
  if (root) root.innerHTML = '';
}

async function openMailSheet(id) {
  openSheet(`<div class="muted" style="padding:20px;text-align:center">লোড হচ্ছে…</div>`);
  try {
    const m = await api(`messages/${id}`);
    const rowMsg = S.msgs.find((x) => x.id === id);
    if (rowMsg && !rowMsg.read) { rowMsg.read = true; S.unread = Math.max(0, S.unread - 1); updateUnreadBadge(); if (S.tab === 'inbox') renderView(); }
    const fmtOtp = m.otp ? (S.settings.otpFormat === 'spaced' ? formatCode(m.otp) : m.otp) : '';
    const linksHtml = (m.linkList || []).slice(0, 4).map((l) =>
      `<button type="button" class="btn sm primary" data-act="openExtLink" data-url="${esc(l.url)}">${ic('link', 'ic-sm')}<span>${esc(l.label || l.host)}</span></button>`
    ).join('');

    openSheet(`
      <div class="sheet-header">
        <h3 style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.service?.name || 'Message')}</h3>
        <div class="row" style="gap:5px">
          <button type="button" class="icon-btn ${m.pinned ? 'active' : ''}" data-act="pinMsg" data-id="${esc(m.id)}" data-p="${m.pinned ? '0' : '1'}">${ic('star', 'ic-sm')}</button>
          <button type="button" class="icon-btn danger" data-act="delMsg" data-id="${esc(m.id)}">${ic('trash', 'ic-sm')}</button>
          <button type="button" class="icon-btn" data-act="closeSheet">${ic('x', 'ic-sm')}</button>
        </div>
      </div>

      ${m.otp ? `
        <div class="card row-between" style="border-color:rgba(16,185,129,0.4);background:var(--ok-soft)">
          <div>
            <div style="font-size:11px;font-weight:700;color:var(--ok)">VERIFICATION CODE</div>
            <div class="mono" style="font-size:24px;font-weight:700;letter-spacing:0.06em">${esc(fmtOtp)}</div>
          </div>
          <button type="button" class="btn ok" data-act="copyRaw" data-v="${esc(m.otp)}">${ic('copy', 'ic-sm')}<span>কপি</span></button>
        </div>` : ''}

      ${linksHtml ? `<div class="row" style="flex-wrap:wrap;gap:6px">${linksHtml}</div>` : ''}

      <div class="card stack" style="gap:4px;font-size:12px">
        <div><span class="muted">Subject:</span> <strong>${esc(m.subject || '(No subject)')}</strong></div>
        <div><span class="muted">From:</span> ${esc(m.from || '—')}</div>
        <div><span class="muted">To:</span> <span class="mono">${esc(m.to)}</span></div>
      </div>

      ${m.html ? `
        <div class="seg">
          <button type="button" class="on" data-act="readerTab" data-mode="text">Clean Text</button>
          <button type="button" data-act="readerTab" data-mode="html">Original HTML</button>
        </div>
        <div id="readerTextPane" class="reader-plain">${esc(m.text || '(No text content)')}</div>
        <iframe id="readerHtmlPane" class="reader-frame" sandbox="allow-same-origin" hidden></iframe>`
        : `<div class="reader-plain">${esc(m.text || '(Empty message)')}</div>`}
    `);
    const frame = $('#readerHtmlPane');
    if (frame && m.html) frame.srcdoc = m.html;
  } catch (e) {
    closeSheet();
    toast('⚠️ ' + e.message);
  }
}

function openCustomSheet() {
  const doms = ['random', ...S.domains];
  if (!S.customDom) S.customDom = S.prefDomain >= 0 ? (S.domains[S.prefDomain] || 'random') : 'random';
  const ttls = [{ v: 0, l: 'স্থায়ী' }, { v: 10, l: '10m' }, { v: 60, l: '1h' }, { v: 1440, l: '24h' }];
  openSheet(`
    <div class="sheet-header"><h3>কাস্টম ইমেইল তৈরি</h3><button type="button" class="icon-btn" data-act="closeSheet">${ic('x', 'ic-sm')}</button></div>
    <div class="field"><label>নাম (কমপক্ষে ৩ অক্ষর, খালি রাখলে র‍্যান্ডম)</label><input id="custName" class="input mono" placeholder="e.g. ariyan_dev"></div>
    <div class="field"><label>ডোমেইন</label>
      <div class="chip-bar">${doms.map((d) => `<button type="button" class="chip ${S.customDom === d ? 'on' : ''}" data-act="pickCustomDom" data-d="${esc(d)}">${d === 'random' ? 'Auto-Random' : `@${esc(d)}`}</button>`).join('')}</div>
    </div>
    <div class="field"><label>লেবেল / ট্যাগ (ঐচ্ছিক)</label><input id="custLabel" class="input" placeholder="যেমন: OpenAI, Shopping"></div>
    <div class="field"><label>মেয়াদ (TTL)</label>
      <div class="seg" id="custTtlSeg">${ttls.map((t) => `<button type="button" class="${S.settings.ttl === t.v ? 'on' : ''}" data-act="pickSeg" data-v="${t.v}">${t.l}</button>`).join('')}</div>
    </div>
    <button type="button" class="btn primary full" data-act="submitCustom">${ic('bolt', 'ic-sm')}<span>ঠিকানা তৈরি করুন</span></button>
  `);
}

function openDomainSheet() {
  openSheet(`
    <div class="sheet-header"><h3>ডোমেইন নির্বাচন</h3><button type="button" class="icon-btn" data-act="closeSheet">${ic('x', 'ic-sm')}</button></div>
    <div class="stack">
      <button type="button" class="btn ${S.prefDomain === -1 ? 'primary' : ''} full" data-act="setPrefDomain" data-d="random">🎲 Auto-Random (সব ডোমেইন)</button>
      ${S.domains.map((d, i) => `<button type="button" class="btn ${S.prefDomain === i ? 'primary' : ''} full" data-act="setPrefDomain" data-d="${esc(d)}">@${esc(d)}</button>`).join('')}
    </div>
  `);
}

function openQrSheet(val) {
  if (!val) { toast('আগে একটি ইমেইল সিলেক্ট করুন'); return; }
  openSheet(`
    <div class="sheet-header"><h3>QR Code</h3><button type="button" class="icon-btn" data-act="closeSheet">${ic('x', 'ic-sm')}</button></div>
    <div class="qr-box">${renderQrSvg(val, 210)}</div>
    <div class="mono" style="text-align:center;font-size:12.5px;word-break:break-all;color:var(--text-2)">${esc(val)}</div>
    <button type="button" class="btn primary full" data-act="copyRaw" data-v="${esc(val)}">${ic('copy', 'ic-sm')}<span>কপি করুন</span></button>
  `);
}

function openAddTotpSheet() {
  const canScan = Boolean(tg?.showScanQrPopup);
  openSheet(`
    <div class="sheet-header"><h3>নতুন 2FA / Import</h3><button type="button" class="icon-btn" data-act="closeSheet">${ic('x', 'ic-sm')}</button></div>
    <div class="row">
      ${canScan ? `<button type="button" class="btn primary" style="flex:1" data-act="scanTotpQr">${ic('camera', 'ic-sm')}<span>QR স্ক্যান</span></button>` : ''}
      <button type="button" class="btn" style="flex:1" data-act="pasteTotpClip">${ic('copy', 'ic-sm')}<span>পেস্ট করুন</span></button>
    </div>
    <div class="field">
      <label>Secret Key, otpauth:// URI, Google Auth Migration বা Bulk তালিকা</label>
      <textarea id="totpRawInput" class="textarea" placeholder="JBSWY3DPEHPK3PXP\nঅথবা GitHub | JBSW...\nঅথবা otpauth-migration://offline?data=..."></textarea>
    </div>
    <div id="totpParsePreview" class="muted"></div>
    <div class="field"><label>অ্যাকাউন্টের নাম (একটির ক্ষেত্রে)</label><input id="totpNameInput" class="input" placeholder="যেমন: GitHub Personal"></div>
    <div class="row">
      <div class="field" style="flex:1"><label>Digits</label><select id="totpDigits" class="select"><option value="6">6 Digits</option><option value="8">8 Digits</option></select></div>
      <div class="field" style="flex:1"><label>Algorithm</label><select id="totpAlgo" class="select"><option value="SHA1">SHA1</option><option value="SHA256">SHA256</option><option value="SHA512">SHA512</option></select></div>
    </div>
    <button type="button" class="btn primary full" data-act="saveTotpAdd">${ic('shield', 'ic-sm')}<span>ভল্টে সেভ করুন</span></button>
  `);
}

function openTotpDetailSheet(id) {
  const t = S.totp.find((x) => x.id === id);
  if (!t) return;
  const uri = buildOtpAuthUri(t);
  openSheet(`
    <div class="sheet-header"><h3>${esc(t.name)}</h3><button type="button" class="icon-btn" data-act="closeSheet">${ic('x', 'ic-sm')}</button></div>
    <div class="qr-box">${renderQrSvg(uri, 190)}</div>
    <div class="card row-between">
      <div style="min-width:0;flex:1">
        <div class="muted">Secret Key (${t.algo || 'SHA1'} • ${t.digits || 6}d)</div>
        <div id="revealSecretText" class="mono" style="font-size:12.5px;margin-top:2px;word-break:break-all">${esc(t.masked)}</div>
      </div>
      <button type="button" class="btn sm" data-act="revealTotpSecret" data-s="${esc(t.secret)}">দেখুন</button>
    </div>
    <div class="row">
      <button type="button" class="btn primary" style="flex:1" data-act="copyRaw" data-v="${esc(uri)}">URI কপি</button>
      <button type="button" class="btn danger" data-act="delTotp" data-id="${esc(t.id)}">ডিলিট</button>
    </div>
  `);
}

function openBackupSheet() {
  openSheet(`
    <div class="sheet-header"><h3>ভল্ট ব্যাকআপ ও রিস্টোর</h3><button type="button" class="icon-btn" data-act="closeSheet">${ic('x', 'ic-sm')}</button></div>
    <div class="field"><label>এনক্রিপশন পাসওয়ার্ড (ঐচ্ছিক — খালি রাখলে প্লেইন JSON)</label><input id="bkpPass" class="input" type="password" placeholder="শক্তিশালী পাসওয়ার্ড দিন…"></div>
    <div class="row">
      <button type="button" class="btn primary" style="flex:1" data-act="exportBackupFile">${ic('download', 'ic-sm')}<span>ব্যাকআপ তৈরি</span></button>
      <button type="button" class="btn" data-act="copyBackupJson">${ic('copy', 'ic-sm')}<span>কপি JSON</span></button>
    </div>
    <div class="field" style="margin-top:6px">
      <label>ব্যাকআপ JSON পেস্ট করে রিস্টোর করুন</label>
      <textarea id="bkpRestoreText" class="textarea" placeholder='{"version":4,"totp":[...]} বা এনক্রিপ্টেড ভল্ট পেস্ট করুন'></textarea>
    </div>
    <button type="button" class="btn ok full" data-act="restoreBackupSubmit">${ic('upload', 'ic-sm')}<span>রিস্টোর করুন</span></button>
  `);
}

// ---------- Unified Event Delegation ----------
async function handleAction(el, ev) {
  const act = el.dataset.act;
  if (!act) return;

  if (act === 'goTab') {
    hap('light');
    setTab(el.dataset.tab);
    return;
  }
  if (act === 'closeSheet') { closeSheet(); return; }
  if (act === 'closeSheetBackdrop') { if (ev.target === el) closeSheet(); return; }

  if (act === 'copyHero') {
    if (!el.dataset.v) { await handleAction({ dataset: { act: 'quickGen' } }); return; }
    const ok = await copyAndNotify(el.dataset.v, `কপি হয়েছে: ${el.dataset.v}`);
    if (ok) { el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 1100); }
    return;
  }
  if (act === 'copyRaw') { await copyAndNotify(el.dataset.v); return; }

  if (act === 'copyMsgOtp') {
    ev.stopPropagation();
    const ok = await copyAndNotify(el.dataset.v, `কোড কপি হয়েছে: ${el.dataset.v}`);
    if (ok && S.settings.autoMarkReadOnCopy && el.dataset.id) {
      api(`messages/${el.dataset.id}`, { method: 'POST' }).then(() => refreshMessages(false)).catch(() => {});
    }
    return;
  }
  if (act === 'copyDockOtp') {
    ev.stopPropagation();
    if (!S.activeOtp) return;
    const ok = await copyAndNotify(S.activeOtp.otp, `কোড কপি হয়েছে: ${S.activeOtp.otp}`);
    if (ok) {
      S.activeOtp.copied = true;
      renderOtpDock();
      if (S.settings.autoMarkReadOnCopy && S.activeOtp.id) {
        api(`messages/${S.activeOtp.id}`, { method: 'POST' }).then(() => refreshMessages(false)).catch(() => {});
      }
    }
    return;
  }
  if (act === 'openDockLink') {
    ev.stopPropagation();
    const url = el.dataset.url;
    if (url) (tg?.openLink ? tg.openLink(url) : window.open(url, '_blank'));
    return;
  }
  if (act === 'dismissDock') { ev.stopPropagation(); S.activeOtp = null; renderOtpDock(); return; }

  if (act === 'quickGen') {
    hap('medium');
    try {
      const dom = S.prefDomain === -1 ? 'random' : (S.domains[S.prefDomain] || 'random');
      const d = await api('addresses', { method: 'POST', body: { domain: dom, ttl: S.settings.ttl || 0 } });
      if (d.address) {
        S.selectedAddr = '';
        S.addrs = [d.address, ...S.addrs.filter((x) => x.addr !== d.address.addr)];
        persistLocalVaults();
        renderView();
        await copyText(d.address.addr);
        toast(`✨ নতুন মেইল ও কপি: ${d.address.addr}`);
      }
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }

  if (act === 'testmail') {
    hap('medium');
    try {
      const d = await api('testmail', { method: 'POST' });
      toast(`⚡ টেস্ট OTP পাঠানো হয়েছে (${d.code})`);
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }

  if (act === 'refresh') { hap('light'); refreshMessages(true); loadAddresses(); return; }
  if (act === 'openDomainPicker') { openDomainSheet(); return; }
  if (act === 'setPrefDomain') {
    try {
      const r = await api('domain', { method: 'POST', body: { domain: el.dataset.d } });
      S.prefDomain = r.prefDomain;
      closeSheet();
      renderView();
      toast(r.prefDomain === -1 ? '🎲 Auto-Random ডোমেইন সক্রিয়' : `✓ ডোমেইন: @${r.domain}`);
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }

  if (act === 'openCustomSheet') { openCustomSheet(); return; }
  if (act === 'pickCustomDom') {
    S.customDom = el.dataset.d;
    $$('[data-act="pickCustomDom"]').forEach((b) => b.classList.toggle('on', b.dataset.d === S.customDom));
    return;
  }
  if (act === 'pickSeg') {
    el.parentElement.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
    el.classList.add('on');
    return;
  }
  if (act === 'submitCustom') {
    const name = ($('#custName')?.value || '').trim();
    const label = ($('#custLabel')?.value || '').trim();
    const ttl = Number($('#custTtlSeg .on')?.dataset?.v || 0);
    try {
      const d = await api('addresses', { method: 'POST', body: { name, label, ttl, domain: S.customDom || 'random' } });
      if (d.address) {
        S.selectedAddr = d.address.addr;
        S.addrs = [d.address, ...S.addrs.filter((x) => x.addr !== d.address.addr)];
        persistLocalVaults();
        closeSheet();
        renderView();
        await copyAndNotify(d.address.addr, `তৈরি ও কপি: ${d.address.addr}`);
      }
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }

  if (act === 'openQrSheet') { openQrSheet(el.dataset.v); return; }

  if (act === 'selectAddrFilter') {
    S.selectedAddr = el.dataset.v || '';
    lsSet('selectedMail', S.selectedAddr);
    if (el.dataset.go === 'inbox') setTab('inbox');
    refreshMessages(false);
    return;
  }
  if (act === 'setMailFilter') { S.mailFilter = el.dataset.f || 'all'; refreshMessages(false); return; }
  if (act === 'clearMailSearch') { S.mailQuery = ''; refreshMessages(false); return; }
  if (act === 'markAllRead') {
    await api('messages/readall', { method: 'POST' }).catch(() => {});
    S.msgs.forEach((m) => { m.read = true; });
    S.unread = 0;
    updateUnreadBadge();
    renderView();
    toast('✓ সব মেইল পঠিত হয়েছে');
    return;
  }

  if (act === 'openMail') { openMailSheet(el.dataset.id); return; }
  if (act === 'openExtLink') {
    const url = el.dataset.url;
    if (url) (tg?.openLink ? tg.openLink(url) : window.open(url, '_blank'));
    return;
  }
  if (act === 'pinMsg') {
    const p = el.dataset.p === '1';
    await api(`messages/${el.dataset.id}`, { method: 'PATCH', body: { pinned: p } }).catch(() => {});
    toast(p ? '★ পিন করা হয়েছে' : '☆ আনপিন হয়েছে');
    openMailSheet(el.dataset.id);
    refreshMessages(false);
    return;
  }
  if (act === 'delMsg') {
    await api(`messages/${el.dataset.id}`, { method: 'DELETE' }).catch(() => {});
    S.msgs = S.msgs.filter((m) => m.id !== el.dataset.id);
    closeSheet();
    renderView();
    toast('🗑 মেইল ডিলিট হয়েছে');
    return;
  }
  if (act === 'readerTab') {
    el.parentElement.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
    el.classList.add('on');
    const isHtml = el.dataset.mode === 'html';
    if ($('#readerTextPane')) $('#readerTextPane').hidden = isHtml;
    if ($('#readerHtmlPane')) $('#readerHtmlPane').hidden = !isHtml;
    return;
  }

  // 2FA Vault Actions
  if (act === 'copyTotpCard') {
    const code = el.dataset.code || '';
    if (!code || code.includes('-')) return;
    const ok = await copyAndNotify(code, `2FA কোড কপি: ${formatCode(code)}`);
    if (ok) { el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 900); }
    return;
  }
  if (act === 'pinTotp') {
    ev.stopPropagation();
    await api('totp', { method: 'PATCH', body: { id: el.dataset.id, pinned: el.dataset.p === '1' } }).catch(() => {});
    loadTotp();
    return;
  }
  if (act === 'setTotpCat') { S.totpCat = el.dataset.c || 'all'; renderView(); tickTotpDom(); return; }
  if (act === 'openAddTotpSheet') { openAddTotpSheet(); return; }
  if (act === 'openTotpDetail') { ev.stopPropagation(); openTotpDetailSheet(el.dataset.id); return; }
  if (act === 'revealTotpSecret') {
    if ($('#revealSecretText')) $('#revealSecretText').textContent = el.dataset.s || '';
    await copyAndNotify(el.dataset.s, 'Secret Key কপি হয়েছে');
    return;
  }
  if (act === 'delTotp') {
    await api(`totp/${el.dataset.id}`, { method: 'DELETE' }).catch(() => {});
    closeSheet();
    loadTotp();
    toast('🗑 2FA মুছে ফেলা হয়েছে');
    return;
  }
  if (act === 'scanTotpQr') {
    tg?.showScanQrPopup?.({ text: 'Authenticator QR কোড স্ক্যান করুন' }, (raw) => {
      if (raw && $('#totpRawInput')) {
        $('#totpRawInput').value = raw;
        $('#totpRawInput').dispatchEvent(new Event('input', { bubbles: true }));
        toast('✓ QR স্ক্যান সম্পন্ন');
        return true;
      }
      return false;
    });
    return;
  }
  if (act === 'pasteTotpClip') {
    try {
      const txt = await navigator.clipboard.readText();
      if (txt && $('#totpRawInput')) {
        $('#totpRawInput').value = txt;
        $('#totpRawInput').dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch { toast('বক্সে ট্যাপ করে Paste করুন'); }
    return;
  }
  if (act === 'saveTotpAdd') {
    const raw = ($('#totpRawInput')?.value || '').trim();
    const name = ($('#totpNameInput')?.value || '').trim();
    const digits = Number($('#totpDigits')?.value || 6);
    const algo = $('#totpAlgo')?.value || 'SHA1';
    if (!raw) { toast('⚠️ Secret বা QR URI দিন'); return; }
    const entries = parseBulkInput(raw, name);
    if (!entries.length) { toast('⚠️ বৈধ 2FA Secret পাওয়া যায়নি'); return; }
    try {
      const body = entries.length === 1
        ? { ...entries[0], name: name || entries[0].name, digits, algo }
        : { bulk: entries };
      await api('totp', { method: 'POST', body });
      closeSheet();
      await loadTotp();
      toast(`✓ ${entries.length}টি 2FA ভল্টে যুক্ত হয়েছে`);
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }

  // Hub & Address Actions
  if (act === 'setHubSub') { S.hubSub = el.dataset.s; renderView(); return; }
  if (act === 'pinAddr') { await api('addresses', { method: 'PATCH', body: { id: el.dataset.id, pinned: el.dataset.p === '1' } }); loadAddresses(); return; }
  if (act === 'extendAddr') { await api('addresses', { method: 'PATCH', body: { id: el.dataset.id, extend: 60 } }); loadAddresses(); toast('✓ মেয়াদ +1h বাড়ানো হয়েছে'); return; }
  if (act === 'editAddrLabel') {
    const lbl = prompt('নতুন লেবেল লিখুন:', el.dataset.l || '');
    if (lbl !== null) { await api('addresses', { method: 'PATCH', body: { id: el.dataset.id, label: lbl } }); loadAddresses(); }
    return;
  }
  if (act === 'delAddr') { await api(`addresses/${el.dataset.id}`, { method: 'DELETE' }); loadAddresses(); toast('🗑 অ্যাড্রেস ডিলিট হয়েছে'); return; }
  if (act === 'genPlusAlias') {
    const [u, d] = (el.dataset.email || '').split('@');
    if (u && d) {
      const alias = `${u}+s${Math.floor(100 + Math.random() * 900)}@${d}`;
      await copyAndNotify(alias, `অ্যালিয়াস কপি: ${alias}`);
    }
    return;
  }

  // Gmail & Auto-2FA
  if (act === 'syncGmailNow') { await api('gmail/sync', { method: 'POST' }); await loadGmails(); refreshMessages(false); toast('✓ Gmail সিঙ্ক সম্পন্ন'); return; }
  if (act === 'connectGmailOAuth') {
    try {
      const r = await api('gmail', { method: 'POST', body: { mode: 'oauth' } });
      if (r.url) (tg?.openLink ? tg.openLink(r.url) : window.open(r.url, '_blank'));
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }
  if (act === 'connectGmailAppPass') {
    const email = ($('#gmAppEmail')?.value || '').trim();
    const password = ($('#gmAppPass')?.value || '').trim();
    try {
      await api('gmail', { method: 'POST', body: { mode: 'app_pass', email, password } });
      await loadGmails();
      toast(`✓ ${email} যুক্ত হয়েছে`);
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }
  if (act === 'delGmail') { await api(`gmail?email=${encodeURIComponent(el.dataset.email)}`, { method: 'DELETE' }); loadGmails(); return; }

  if (act === 'startAuto2fa') {
    const email = ($('#a2faEmail')?.value || '').trim();
    const password = ($('#a2faPass')?.value || '').trim();
    const recoveryEmail = ($('#a2faRec')?.value || '').trim();
    try {
      const r = await api('gmail/auto2fa', { method: 'POST', body: { email, password, recoveryEmail } });
      S.auto2fa = r.job;
      if (r.items) S.totp = r.items;
      renderView();
      toast('🤖 Auto 2FA শুরু হয়েছে');
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }
  if (act === 'a2faAction') {
    const r = await api('gmail/auto2fa', { method: 'POST', body: { jobId: el.dataset.id, action: el.dataset.a } }).catch(() => null);
    if (r?.job) { S.auto2fa = r.job; renderView(); }
    return;
  }
  if (act === 'a2faOpt') {
    const r = await api('gmail/auto2fa', { method: 'POST', body: { jobId: el.dataset.id, action: 'option', optionIdx: Number(el.dataset.idx) } }).catch(() => null);
    if (r?.job) { S.auto2fa = r.job; renderView(); }
    return;
  }
  if (act === 'a2faSendInput') {
    const text = ($('#a2faChallengeInput')?.value || '').trim();
    if (!text) return;
    const r = await api('gmail/auto2fa', { method: 'POST', body: { jobId: el.dataset.id, action: 'input', text } }).catch(() => null);
    if (r?.job) { S.auto2fa = r.job; renderView(); }
    return;
  }

  // Settings & Backup
  if (act === 'setSkin') {
    hap('light');
    S.settings.skin = el.dataset.v;
    applyTheme();
    renderView();
    api('settings', { method: 'POST', body: { skin: S.settings.skin } }).catch(() => {});
    return;
  }
  if (act === 'setTheme') {
    hap('light');
    S.settings.theme = el.dataset.v;
    applyTheme();
    renderView();
    api('settings', { method: 'POST', body: { theme: S.settings.theme } }).catch(() => {});
    return;
  }
  if (act === 'toggleSetting') {
    hap('light');
    const k = el.dataset.k;
    S.settings[k] = !S.settings[k];
    applyTheme();
    renderView();
    api('settings', { method: 'POST', body: { [k]: S.settings[k] } }).catch(() => {});
    return;
  }
  if (act === 'openBackupSheet') { openBackupSheet(); return; }
  if (act === 'exportBackupFile' || act === 'copyBackupJson') {
    const pass = ($('#bkpPass')?.value || '').trim();
    const { backup } = await api('backup');
    const out = pass ? await encryptBackup(backup, pass) : JSON.stringify(backup, null, 2);
    if (act === 'copyBackupJson') {
      await copyAndNotify(out, 'ব্যাকআপ কপি হয়েছে');
      return;
    }
    const blob = new Blob([out], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tempmail-vault-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    toast('✓ ব্যাকআপ ফাইল ডাউনলোড হয়েছে');
    return;
  }
  if (act === 'restoreBackupSubmit') {
    const raw = ($('#bkpRestoreText')?.value || '').trim();
    const pass = ($('#bkpPass')?.value || '').trim();
    if (!raw) { toast('⚠️ ব্যাকআপ JSON পেস্ট করুন'); return; }
    try {
      const obj = await decryptBackup(raw, pass);
      const r = await api('backup', { method: 'POST', body: { backup: obj } });
      closeSheet();
      await Promise.all([loadAddresses(), loadTotp(), loadGmails()]);
      toast(`✓ রিস্টোর সম্পন্ন (${r.restoredTotp || 0} 2FA, ${r.restoredAddrs || 0} মেইল)`);
    } catch { toast('⚠️ ভুল পাসওয়ার্ড বা অকার্যকর ব্যাকআপ ডেটা'); }
    return;
  }
  if (act === 'clearInboxConfirm') {
    if (confirm('ইনবক্সের সব মেইল মুছে ফেলবেন?')) {
      await api('messages', { method: 'DELETE' });
      S.msgs = []; S.unread = 0; updateUnreadBadge(); renderView();
      toast('🧹 ইনবক্স খালি হয়েছে');
    }
    return;
  }

  // Admin actions
  if (act === 'admToggleAccess') {
    await api('admin/access', { method: 'POST', body: { open: el.dataset.open === '1' } });
    loadAdmin();
    return;
  }
  if (act === 'admSweep') {
    const r = await api('admin/sweep', { method: 'POST' });
    toast(`🧹 ${r.expired || 0}টি মেয়াদোত্তীর্ণ ঠিকানা পরিষ্কার হয়েছে`);
    loadAdmin();
    return;
  }
  if (act === 'admBroadcast') {
    const text = ($('#admBcInput')?.value || '').trim();
    if (!text) return;
    const r = await api('admin/broadcast', { method: 'POST', body: { text } });
    if ($('#admBcInput')) $('#admBcInput').value = '';
    toast(`📢 ${r.count || 0} জনে পাঠানো শুরু হয়েছে`);
    return;
  }
  if (act === 'admUser') {
    await api('admin/user', { method: 'POST', body: { id: el.dataset.id, action: el.dataset.ua } });
    loadAdmin();
    return;
  }
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (el) handleAction(el, ev);
  else if (ev.target.id === 'otpDock' || ev.target.closest('#otpDock')) {
    const dockBtn = $('#otpDock');
    if (dockBtn && !dockBtn.hidden) handleAction({ dataset: { act: 'copyDockOtp' } }, ev);
  }
});

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.id === 'mailSearchInput') {
    S.mailQuery = t.value;
    clearTimeout(t._tm);
    t._tm = setTimeout(() => refreshMessages(false), 180);
  } else if (t.id === 'totpSearchInput') {
    S.totpQuery = t.value;
    if ($('#totpList')) renderView();
  } else if (t.id === 'totpRawInput') {
    const parsed = parseBulkInput(t.value);
    const prev = $('#totpParsePreview');
    if (prev) {
      prev.textContent = parsed.length
        ? `✓ ${parsed.length}টি এন্ট্রি শনাক্ত হয়েছে: ${parsed.slice(0, 3).map((x) => x.name).join(', ')}${parsed.length > 3 ? '…' : ''}`
        : '';
    }
    if (parsed.length === 1 && $('#totpNameInput') && !$('#totpNameInput').value.trim() && parsed[0].name !== '2FA Account') {
      $('#totpNameInput').value = parsed[0].name;
    }
  }
});

// ---------- Boot ----------
async function init() {
  if (!tg || !INIT_DATA) {
    $('#tgGate').hidden = false;
    $('#appShell').hidden = true;
    $('#bottomNav').hidden = true;
    return;
  }

  tg.ready?.();
  tg.expand?.();
  $('#tgGate').hidden = true;
  $('#appShell').hidden = false;
  $('#bottomNav').hidden = false;

  // Deep link tab routing
  const urlTab = new URLSearchParams(location.search).get('tab') || tg.initDataUnsafe?.start_param || '';
  if (urlTab === 'totp' || urlTab === '2fa') S.tab = 'totp';
  else if (urlTab === 'hub' || urlTab === 'gmail') { S.tab = 'hub'; if (urlTab === 'gmail') S.hubSub = 'gmail'; }
  else if (urlTab === 'settings') S.tab = 'settings';
  else if (urlTab === 'admin') S.tab = 'admin';

  S.selectedAddr = lsGet('selectedMail', '');

  let restoreAddrs = [];
  let restoreTotp = [];
  let restoreGmails = [];
  try {
    const rawA = lsGet('savedAddrs');
    restoreAddrs = rawA ? (rawA.startsWith('[') ? JSON.parse(rawA) : rawA) : [];
    const rawT = lsGet('savedTotp');
    restoreTotp = rawT ? JSON.parse(rawT) : [];
    const rawG = lsGet('savedGmails');
    restoreGmails = rawG ? JSON.parse(rawG) : [];
  } catch {}

  try {
    const boot = await api('bootstrap', {
      method: 'POST',
      body: { restoreAddrs, restoreTotp, restoreGmails },
    });
    S.user = boot.user;
    S.brand = boot.brand || S.brand;
    S.domains = boot.domains?.length ? boot.domains : S.domains;
    S.prefDomain = typeof boot.prefDomain === 'number' ? boot.prefDomain : -1;
    S.gmailEnabled = Boolean(boot.gmailEnabled);
    S.settings = { ...S.settings, ...(boot.settings || {}) };
    S.totp = boot.totp || [];
    S.gmails = boot.gmailVault || [];
    S.auto2fa = boot.activeAuto2fa || null;
    S.unread = boot.unread || 0;
    S.stats = boot.stats || S.stats;
    S.sseToken = boot.sseToken || '';

    $('#brandName').textContent = S.brand;
    $('#brandLogo').textContent = S.brand.slice(0, 1).toUpperCase();
    if (S.user?.admin) $('#navAdmin').hidden = false;
    else if (S.tab === 'admin') S.tab = 'inbox';

    applyTheme();
    try { tg.onEvent?.('themeChanged', () => { if (S.settings.theme === 'auto') applyTheme(); }); } catch {}
    updateUnreadBadge();
    connectEvents();
    await precomputeTotpCodes();
    await Promise.all([loadAddresses(), refreshMessages(false)]);
    setTab(S.tab);
  } catch (e) {
    setLiveStatus(false, 'Offline');
    toast('⚠️ ' + e.message, 4000);
  }
}

init();
