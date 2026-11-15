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

const DARK_THEMES = [
  { id: 'aurora', l: 'Aurora Night', sub: 'Neon Indigo · Dark', bg: 'linear-gradient(135deg,#070a14,#1a1746)', pvCard: 'rgba(109,93,252,0.34)', pvAccent: '#00c2ff', light: false },
  { id: 'claude', l: 'Claude Dark', sub: 'Warm Terracotta · Dark', bg: 'linear-gradient(135deg,#1b1917,#3c2820)', pvCard: 'rgba(217,119,87,0.34)', pvAccent: '#d97757', light: false },
];

const LIGHT_THEMES = [
  { id: 'daylight', l: 'Cloud Light', sub: 'Crisp Frost · Light', bg: 'linear-gradient(135deg,#eef2f7,#dbeafe)', pvCard: 'rgba(255,255,255,0.9)', pvAccent: '#2563eb', light: true },
  { id: 'claude-light', l: 'Claude Cream', sub: 'Warm Paper · Light', bg: 'linear-gradient(135deg,#f5f1e8,#eedcc8)', pvCard: 'rgba(255,253,248,0.92)', pvAccent: '#cc5d38', light: true },
];

const ALL_THEMES = [...DARK_THEMES, ...LIGHT_THEMES];

const LEGACY_THEME_MAP = {
  aurora: 'aurora', midnight: 'aurora', obsidian: 'aurora', ocean: 'aurora', cobalt: 'aurora',
  emerald: 'aurora', cyber: 'aurora', nebula: 'aurora', nord: 'aurora',
  claude: 'claude', amber: 'claude', crimson: 'claude', rose: 'claude',
  daylight: 'daylight', sky: 'daylight', mint: 'daylight', blush: 'daylight',
  'claude-light': 'claude-light',
};

const SKINS = [
  { id: 'glass', l: 'iPhone Glass', pv: 'pv-glass' },
  { id: 'claude', l: 'Claude Studio', pv: 'pv-claude' },
  { id: 'mix', l: 'Glass × Claude', pv: 'pv-mix' },
  { id: 'bento', l: 'Spatial Bento', pv: 'pv-bento' },
  { id: 'obsidian', l: 'OLED Craft', pv: 'pv-obsidian' },
  { id: 'minimal', l: 'Minimal', pv: 'pv-minimal' },
];

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
  hubAddrQuery: '',
  admUserQuery: '',
  customDom: '',
  editDom: '',

  // Active OTP Auto-Copy Dock & Dedupe
  activeOtp: null,
  seenOtpMsgIds: new Set(),
  openTotpId: null,
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
  return LEGACY_THEME_MAP[name] || 'aurora';
}

function applyTheme() {
  const st = S.settings;
  const actualTheme = resolveTheme(st.theme);
  st.theme = actualTheme;
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

// ---------- Keyed Zero-Jump DOM Reconciliation ----------
function parseEl(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

function syncKeyedList(container, items, keyFn, sigFn, htmlFn, emptyHtml) {
  if (!container) return;
  if (!items.length) {
    if (container.dataset.empty !== '1' || container.dataset.emptySig !== emptyHtml) {
      container.innerHTML = emptyHtml;
      container.dataset.empty = '1';
      container.dataset.emptySig = emptyHtml;
    }
    return;
  }
  if (container.dataset.empty === '1') {
    container.innerHTML = '';
    container.dataset.empty = '0';
    delete container.dataset.emptySig;
  }

  const existingMap = new Map();
  for (const child of Array.from(container.children)) {
    const k = child.dataset?.key;
    if (k) existingMap.set(k, child);
    else child.remove();
  }

  const wantedKeys = new Set(items.map((it) => String(keyFn(it))));
  for (const [k, node] of existingMap.entries()) {
    if (!wantedKeys.has(k)) {
      node.remove();
      existingMap.delete(k);
    }
  }

  items.forEach((item, idx) => {
    const key = String(keyFn(item));
    const sig = String(sigFn(item));
    const prev = existingMap.get(key);
    let el = prev;
    if (!prev || prev.dataset.sig !== sig) {
      const nextEl = parseEl(htmlFn(item));
      if (!nextEl) return;
      nextEl.dataset.key = key;
      nextEl.dataset.sig = sig;
      if (prev) prev.replaceWith(nextEl);
      else container.insertBefore(nextEl, container.children[idx] || null);
      el = nextEl;
    }
    if (el && container.children[idx] !== el) {
      container.insertBefore(el, container.children[idx] || null);
    }
  });
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
    to: msg.to || '',
    link: msg.link || null,
    copied,
    ts: Date.now(),
  };
  playChime('otp');
  hap('success');
  renderOtpDock();
}

function renderOtpDock() {
  const dock = $('#otpDock');
  if (!dock) return;
  const cur = S.activeOtp;
  if (!cur) {
    dock.hidden = true;
    dock.classList.remove('copied', 'dock-enter');
    delete dock.dataset.dockId;
    dock.innerHTML = '';
    return;
  }
  const formatted = S.settings.otpFormat === 'spaced' ? formatCode(cur.otp) : cur.otp;
  const isNew = dock.dataset.dockId !== cur.id;
  dock.hidden = false;
  dock.classList.toggle('copied', Boolean(cur.copied));

  if (isNew || !dock.querySelector('.otp-dock-code')) {
    dock.dataset.dockId = cur.id;
    dock.classList.remove('dock-enter');
    void dock.offsetWidth;
    dock.classList.add('dock-enter');
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
  } else {
    const stEl = dock.querySelector('.otp-dock-status');
    if (stEl) stEl.innerHTML = `${ic(cur.copied ? 'check' : 'bolt', 'ic-sm')}<span>${cur.copied ? 'অটো কপি হয়েছে • কীবোর্ডে পেস্ট করুন' : 'নতুন কোড এসেছে • কপি করতে ট্যাপ করুন'}</span>`;
    const codeEl = dock.querySelector('.otp-dock-code');
    if (codeEl) codeEl.textContent = formatted;
    const copyBtn = dock.querySelector('[data-act="copyDockOtp"]');
    if (copyBtn) copyBtn.innerHTML = `${ic(cur.copied ? 'check' : 'copy', 'ic-sm')}<span>${cur.copied ? 'কপিড' : 'কপি'}</span>`;
  }
}

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
        if (S.tab === 'inbox') renderView(false);
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
      if (S.tab === 'hub' && S.hubSub === 'auto2fa') renderView(false);
    } catch {}
  });
  es.addEventListener('domain:changed', (ev) => {
    try {
      const d = JSON.parse(ev.data || '{}');
      if (typeof d.prefDomain === 'number') S.prefDomain = d.prefDomain;
      if (S.tab === 'inbox') renderView(false);
    } catch {}
  });
  es.onerror = () => {
    setLiveStatus(false, 'Reconnecting');
  };
}

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
    if (S.tab === 'inbox') renderView(false);
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
    if (S.tab === 'inbox' || (S.tab === 'hub' && S.hubSub === 'addrs')) renderView(false);
  } catch {}
}

async function loadTotp() {
  try {
    const d = await api('totp');
    S.totp = d.items || [];
    persistLocalVaults();
    await precomputeTotpCodes();
    if (S.tab === 'totp') renderView(false);
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
    if (S.tab === 'inbox' || (S.tab === 'hub' && (S.hubSub === 'gmail' || S.hubSub === 'addrs'))) renderView(false);
  } catch {}
}

async function loadAdmin() {
  if (!S.user?.admin) return;
  try {
    S.adminData = await api('admin/stats');
    if (S.tab === 'admin') renderView(false);
  } catch {}
}

// ---------- High-FPS 2FA Vault Ticker ----------
function tickTotpDom() {
  const now = Date.now();
  const r = 13;
  const circ = 2 * Math.PI * r;

  if (S.tab === 'totp' && S.totp.length) {
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
        const nextStr = nextVal ? `Next ${formatCode(nextVal)}` : '';
        if (nextEl.textContent !== nextStr) nextEl.textContent = nextStr;
        nextEl.classList.toggle('show', sync.remaining <= 10);
      }
      if (ringFg) {
        const frac = Math.max(0, Math.min(1, sync.remainingExact / sync.period));
        ringFg.style.strokeDasharray = String(circ);
        ringFg.style.strokeDashoffset = String(circ * (1 - frac));
        ringFg.classList.toggle('warn', sync.remaining <= 7 && sync.remaining > 3);
        ringFg.classList.toggle('danger', sync.remaining <= 3);
      }
      if (ringNum) {
        const remStr = String(sync.remaining);
        if (ringNum.textContent !== remStr) ringNum.textContent = remStr;
      }
    }
  }

  // Also keep open 2FA detail modal live-ticking smoothly!
  if (S.openTotpId) {
    const t = S.totp.find((x) => x.id === S.openTotpId);
    const liveBox = $('#detailTotpCode');
    const secBadge = $('#detailTotpRem');
    if (t && liveBox) {
      const sync = getCachedTotpSync(t.secret, now, { algo: t.algo, digits: t.digits, period: t.period });
      const codeVal = sync.code || t.code || '------';
      const fmt = formatCode(codeVal);
      if (liveBox.textContent !== fmt) liveBox.textContent = fmt;
      if (liveBox.dataset.raw !== codeVal) liveBox.dataset.raw = codeVal;
      const copyDetailBtn = $('#detailTotpCopyBtn');
      if (copyDetailBtn && copyDetailBtn.dataset.v !== codeVal) copyDetailBtn.dataset.v = codeVal;
      if (secBadge) secBadge.textContent = `${sync.remaining}s`;
    }
  }
}
setInterval(tickTotpDom, 200);

// ---------- Navigation & Tab Mount Engine ----------
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
  const changed = S.tab !== tab;
  S.tab = tab;
  $$('.nav-item').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  requestAnimationFrame(updateNavPill);
  renderView(changed);
  if (tab === 'totp') loadTotp();
  if (tab === 'hub') {
    if (S.hubSub === 'addrs') loadAddresses();
    if (S.hubSub === 'gmail') loadGmails();
    if (S.hubSub === 'auto2fa') api('gmail/auto2fa').then((d) => { S.auto2fa = d.job; renderView(false); }).catch(() => {});
  }
  if (tab === 'admin') loadAdmin();
}

function renderView(forceMount = false) {
  const root = $('#viewRoot');
  if (!root) return;
  const curSection = root.firstElementChild;
  const isSameTab = curSection && curSection.dataset?.view === S.tab;

  if (!isSameTab || forceMount) {
    if (S.tab === 'inbox') root.innerHTML = mountInboxHtml();
    else if (S.tab === 'totp') root.innerHTML = mountTotpHtml();
    else if (S.tab === 'hub') root.innerHTML = mountHubHtml();
    else if (S.tab === 'settings') root.innerHTML = mountSettingsHtml();
    else if (S.tab === 'admin') root.innerHTML = mountAdminHtml();
    const nextSec = root.firstElementChild;
    if (nextSec) nextSec.classList.add('view-enter');
  }

  if (S.tab === 'inbox') syncInboxDom();
  else if (S.tab === 'totp') { syncTotpDom(); tickTotpDom(); }
  else if (S.tab === 'hub') syncHubDom();
  else if (S.tab === 'settings') syncSettingsDom();
  else if (S.tab === 'admin') syncAdminDom();
}

// ---------- Tab 1: Smart Inbox (Zero-Jump) ----------
function mountInboxHtml() {
  return `
  <section class="view" data-view="inbox">
    <div class="card identity-card">
      <div class="identity-meta">
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <span class="badge accent" id="heroDomainBadge">${ic('globe', 'ic-sm')}<span id="heroDomainLabel"></span></span>
          <button type="button" class="badge" data-act="openDomainPicker">${ic('sliders', 'ic-sm')}<span>ডোমেইন</span></button>
        </div>
        <div class="row" style="gap:5px">
          <span class="badge" id="heroLabelBadge" hidden></span>
          <span class="badge ok" id="heroTtlBadge"></span>
        </div>
      </div>

      <button type="button" class="addr-tapbox" id="heroCopyBtn" data-act="copyHero" data-v="">
        <code id="heroAddrCode"></code>
        <span class="copy-hint">${ic('copy', 'ic-sm')}<span>কপি</span></span>
      </button>

      <div class="hero-actions" style="grid-template-columns:1.15fr 1fr auto auto">
        <button type="button" class="btn primary" data-act="quickGen">${ic('refresh', 'ic-sm')}<span>নতুন মেইল</span></button>
        <button type="button" class="btn soft-primary" data-act="openCustomSheet">${ic('plus', 'ic-sm')}<span>কাস্টম</span></button>
        <button type="button" class="btn" id="heroEditBtn" data-act="openEditAddr" data-id="" title="রিনেম / এডিট">${ic('edit', 'ic-sm')}</button>
        <button type="button" class="btn" id="heroQrBtn" data-act="openQrSheet" data-v="" aria-label="QR Code">${ic('qr')}</button>
      </div>
    </div>

    <div class="chip-bar" id="addrChipBar"></div>

    <div class="row">
      <div class="search-wrap" style="flex:1">
        ${ic('search', 'ic-sm')}
        <input id="mailSearchInput" type="search" placeholder="সার্চ: OTP, সার্ভিস, ঠিকানা…" value="${esc(S.mailQuery)}">
        <button type="button" id="mailClearBtn" data-act="clearMailSearch" ${S.mailQuery ? '' : 'hidden'}>${ic('x', 'ic-sm')}</button>
      </div>
      <button type="button" class="icon-btn soft-ok" data-act="markAllRead" title="সব পঠিত">${ic('check', 'ic-sm')}</button>
    </div>

    <div class="chip-bar" id="mailFilterBar"></div>

    <div class="mail-list" id="mailList"></div>
  </section>`;
}

function mailRowHtml(m) {
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
      ${m.note ? `<div class="row"><span class="mail-note-pill">${ic('note', 'ic-sm')}<span>${esc(m.note)}</span></span></div>` : ''}
      <div class="mail-foot">
        <span class="mail-to">${esc(m.to)}</span>
        ${otpFmt ? `<button type="button" class="otp-pill" data-act="copyMsgOtp" data-v="${esc(m.otp)}" data-id="${esc(m.id)}">${ic('key', 'ic-sm')}<span>${esc(otpFmt)}</span></button>` : ''}
      </div>
    </div>
  </div>`;
}

function syncInboxDom() {
  const act = activeTempAddr();
  const activeAddrStr = S.selectedAddr || act?.addr || '';
  const domModeLabel = S.prefDomain === -1 ? 'Auto-Random' : (S.domains[S.prefDomain] || S.domains[0]);

  const domLbl = $('#heroDomainLabel');
  if (domLbl) domLbl.textContent = domModeLabel;

  const lblBadge = $('#heroLabelBadge');
  if (lblBadge) {
    if (act?.label) {
      lblBadge.hidden = false;
      lblBadge.className = 'badge accent';
      lblBadge.textContent = act.label;
    } else {
      lblBadge.hidden = true;
    }
  }

  const ttlBadge = $('#heroTtlBadge');
  if (ttlBadge) {
    ttlBadge.className = `badge ${act?.expiresAt ? 'warn' : 'ok'}`;
    ttlBadge.textContent = fmtTtl(act);
  }

  const heroCopy = $('#heroCopyBtn');
  if (heroCopy) heroCopy.dataset.v = activeAddrStr;
  const heroCode = $('#heroAddrCode');
  if (heroCode) heroCode.textContent = activeAddrStr || 'ট্যাপ করে নতুন মেইল তৈরি করুন';
  const heroQr = $('#heroQrBtn');
  if (heroQr) heroQr.dataset.v = activeAddrStr;
  const heroEdit = $('#heroEditBtn');
  if (heroEdit) {
    heroEdit.dataset.id = act?.id || '';
    heroEdit.hidden = !act;
  }

  const clearBtn = $('#mailClearBtn');
  if (clearBtn) clearBtn.hidden = !S.mailQuery;

  const searchInp = $('#mailSearchInput');
  if (searchInp && document.activeElement !== searchInp && searchInp.value !== S.mailQuery) {
    searchInp.value = S.mailQuery;
  }

  const switcherItems = [
    { addr: '', label: `সব ইনবক্স (${S.stats.total || S.msgs.length})` },
    ...S.addrs.filter((a) => !a.expired).slice(0, 8).map((a) => ({ addr: a.addr, label: a.label ? `${a.label} · ${a.addr.split('@')[0]}` : a.addr })),
    ...S.gmails.map((g) => ({ addr: g.email, label: g.label ? `${g.label} · Gmail` : g.email })),
  ];
  const addrBar = $('#addrChipBar');
  if (addrBar) {
    const sl = addrBar.scrollLeft;
    const chipSig = switcherItems.map((x) => `${x.addr}:${x.label}:${S.selectedAddr === x.addr}`).join('|');
    if (addrBar.dataset.sig !== chipSig) {
      addrBar.dataset.sig = chipSig;
      addrBar.innerHTML = switcherItems.map((it) => `<button type="button" class="chip ${S.selectedAddr === it.addr ? 'on' : ''}" data-act="selectAddrFilter" data-v="${esc(it.addr)}">${esc(it.label)}</button>`).join('');
      addrBar.scrollLeft = sl;
    }
  }

  const chips = [
    { id: 'all', l: 'সব' },
    { id: 'unread', l: `অপঠিত${S.unread ? ` (${S.unread})` : ''}` },
    { id: 'otp', l: 'OTP কোড' },
    { id: 'link', l: 'ভেরিফাই লিংক' },
    { id: 'pinned', l: 'পিন করা' },
  ];
  const filterBar = $('#mailFilterBar');
  if (filterBar) {
    const sl = filterBar.scrollLeft;
    const fSig = chips.map((c) => `${c.id}:${c.l}:${S.mailFilter === c.id}`).join('|');
    if (filterBar.dataset.sig !== fSig) {
      filterBar.dataset.sig = fSig;
      filterBar.innerHTML = chips.map((c) => `<button type="button" class="chip ok ${S.mailFilter === c.id ? 'on' : ''}" data-act="setMailFilter" data-f="${c.id}">${c.l}</button>`).join('');
      filterBar.scrollLeft = sl;
    }
  }

  const emptyHtml = `<div class="empty">
    <div class="empty-icon">${ic('inbox', 'ic-lg')}</div>
    <h3>ইনবক্স খালি</h3>
    <p>${S.selectedAddr ? `${esc(S.selectedAddr)}-এ এখনো কোনো মেইল আসেনি` : 'উপরের ঠিকানাটি কপি করে কোনো সাইটে ব্যবহার করুন — OTP সাথে সাথে এখানে চলে আসবে।'}</p>
    <div class="row" style="justify-content:center">
      <button type="button" class="btn primary sm" data-act="quickGen">${ic('bolt', 'ic-sm')}<span>নতুন মেইল</span></button>
      <button type="button" class="btn soft-ok sm" data-act="testmail">${ic('shield', 'ic-sm')}<span>টেস্ট OTP</span></button>
    </div>
  </div>`;

  syncKeyedList(
    $('#mailList'),
    S.msgs,
    (m) => m.id,
    (m) => `${m.read ? 1 : 0}|${m.pinned ? 1 : 0}|${m.otp || ''}|${m.note || ''}|${m.subject || ''}|${m.to}|${S.settings.otpFormat}|${relTime(m.date)}`,
    mailRowHtml,
    emptyHtml
  );
}

// ---------- Tab 2: 2FA Vault (Zero-Jump) ----------
function mountTotpHtml() {
  return `
  <section class="view" data-view="totp">
    <div class="row-between">
      <div>
        <strong style="font-size:16px">2FA Authenticator Vault</strong>
        <div class="muted" id="totpCountLabel"></div>
      </div>
      <div class="row" style="gap:6px">
        <button type="button" class="btn sm soft-primary" data-act="openBackupSheet" title="Backup">${ic('download', 'ic-sm')}<span>ব্যাকআপ</span></button>
        <button type="button" class="btn sm primary" data-act="openAddTotpSheet">${ic('plus', 'ic-sm')}<span>যোগ করুন</span></button>
      </div>
    </div>

    <div class="search-wrap">
      ${ic('search', 'ic-sm')}
      <input id="totpSearchInput" type="search" placeholder="2FA অ্যাকাউন্ট বা সার্ভিস খুঁজুন…" value="${esc(S.totpQuery)}">
      <button type="button" id="totpClearBtn" data-act="clearTotpSearch" ${S.totpQuery ? '' : 'hidden'}>${ic('x', 'ic-sm')}</button>
    </div>

    <div class="chip-bar" id="totpCatBar"></div>

    <div class="totp-list" id="totpList"></div>
  </section>`;
}

function totpCardHtml(t) {
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
        <button type="button" class="icon-btn ${t.pinned ? 'soft-warn active' : ''}" data-act="pinTotp" data-id="${esc(t.id)}" data-p="${t.pinned ? '0' : '1'}" title="Pin">${ic('star', 'ic-sm')}</button>
        <button type="button" class="icon-btn soft-primary" data-act="openTotpDetail" data-id="${esc(t.id)}" title="এডিট ও QR">${ic('edit', 'ic-sm')}</button>
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
}

function syncTotpDom() {
  const cnt = $('#totpCountLabel');
  if (cnt) cnt.textContent = `${S.totp.length}টি সুরক্ষিত অ্যাকাউন্ট • ট্যাপ করলেই কপি`;

  const clearBtn = $('#totpClearBtn');
  if (clearBtn) clearBtn.hidden = !S.totpQuery;

  const cats = ['all', 'pinned', ...new Set(S.totp.map((t) => t.category).filter((c) => c && c !== 'General'))];
  const catBar = $('#totpCatBar');
  if (catBar) {
    const sl = catBar.scrollLeft;
    const cSig = cats.map((c) => `${c}:${S.totpCat === c}`).join('|');
    if (catBar.dataset.sig !== cSig) {
      catBar.dataset.sig = cSig;
      catBar.innerHTML = cats.map((c) => `<button type="button" class="chip ${S.totpCat === c ? 'on' : ''}" data-act="setTotpCat" data-c="${esc(c)}">${c === 'all' ? 'সবগুলো' : c === 'pinned' ? '★ পিন করা' : esc(c)}</button>`).join('');
      catBar.scrollLeft = sl;
    }
  }

  const q = S.totpQuery.trim().toLowerCase();
  const filtered = S.totp.filter((t) => {
    if (S.totpCat === 'pinned' && !t.pinned) return false;
    if (S.totpCat !== 'all' && S.totpCat !== 'pinned' && t.category !== S.totpCat) return false;
    if (q && !`${t.name} ${t.issuer || ''} ${t.category || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const emptyHtml = `<div class="empty">
    <div class="empty-icon">${ic('shield', 'ic-lg')}</div>
    <h3>${S.totp.length ? 'কোনো ম্যাচ পাওয়া যায়নি' : '2FA ভল্ট খালি'}</h3>
    <p>${S.totp.length ? 'সার্চ বা ফিল্টার পরিবর্তন করে দেখুন।' : 'QR কোড স্ক্যান করুন অথবা Secret Key / otpauth URI যোগ করে লাইভ কোড পান।'}</p>
    ${S.totp.length ? '' : `<button type="button" class="btn primary sm" data-act="openAddTotpSheet">${ic('plus', 'ic-sm')}<span>নতুন 2FA যোগ করুন</span></button>`}
  </div>`;

  syncKeyedList(
    $('#totpList'),
    filtered,
    (t) => t.id,
    (t) => `${t.name}|${t.issuer || ''}|${t.category || ''}|${t.pinned ? 1 : 0}|${t.digits || 6}|${t.algo || 'SHA1'}|${t.period || 30}`,
    totpCardHtml,
    emptyHtml
  );
}

// ---------- Tab 3: Mail & Gmail Hub (Zero-Jump) ----------
function mountHubHtml() {
  return `
  <section class="view" data-view="hub">
    <div class="seg" id="hubSubBar"></div>
    <div id="hubBody" class="stack" style="gap:12px"></div>
  </section>`;
}

function addrCardHtml(a) {
  const isSelected = S.selectedAddr === a.addr;
  return `
  <div class="card stack" style="gap:9px">
    <div class="row-between">
      <div style="min-width:0;flex:1">
        <div class="row wrap" style="gap:5px">
          ${a.pinned ? `<span class="badge warn">★ Pin</span>` : ''}
          ${a.label ? `<span class="badge accent">${ic('tag', 'ic-sm')}<span>${esc(a.label)}</span></span>` : ''}
          ${isSelected ? `<span class="badge ok">Active</span>` : ''}
          <span class="badge ${a.expired ? 'danger' : 'ok'}">${esc(fmtTtl(a))}</span>
        </div>
        <div class="mono" style="font-size:13.5px;font-weight:700;margin-top:6px;word-break:break-all">${esc(a.addr)}</div>
        <div class="muted">${a.count || 0}টি মেসেজ</div>
      </div>
      <div class="row" style="gap:5px;flex-shrink:0">
        <button type="button" class="icon-btn soft-primary" data-act="copyRaw" data-v="${esc(a.addr)}" title="Copy">${ic('copy', 'ic-sm')}</button>
        <button type="button" class="icon-btn ${a.pinned ? 'soft-warn active' : ''}" data-act="pinAddr" data-id="${esc(a.id)}" data-p="${a.pinned ? '0' : '1'}" title="Pin">${ic('star', 'ic-sm')}</button>
      </div>
    </div>
    <div class="row wrap" style="gap:6px">
      <button type="button" class="ic-pill blue" data-act="selectAddrFilter" data-v="${esc(a.addr)}" data-go="inbox">${ic('inbox', 'ic-sm')}<span>ইনবক্স</span></button>
      <button type="button" class="ic-pill purple" data-act="openEditAddr" data-id="${esc(a.id)}">${ic('edit', 'ic-sm')}<span>রিনেম / এডিট</span></button>
      <button type="button" class="ic-pill green" data-act="extendAddr" data-id="${esc(a.id)}">${ic('clock', 'ic-sm')}<span>+1h</span></button>
      <button type="button" class="ic-pill red" data-act="openEditAddr" data-id="${esc(a.id)}" data-del="1">${ic('trash', 'ic-sm')}<span>ডিলিট</span></button>
    </div>
  </div>`;
}

function gmailCardHtml(g) {
  return `
  <div class="card row-between">
    <div style="min-width:0;flex:1">
      <div class="row wrap" style="gap:5px">
        <span class="badge ${g.status === 'expired' ? 'warn' : 'ok'}">${g.status === 'expired' ? 'মেয়াদ শেষ' : 'লাইভ সিঙ্ক'}</span>
        ${g.label ? `<span class="badge accent">${ic('tag', 'ic-sm')}<span>${esc(g.label)}</span></span>` : ''}
        ${g.twoFaEnabled ? '<span class="badge info">2FA Active</span>' : ''}
      </div>
      <div class="mono" style="font-size:13px;font-weight:700;margin-top:5px;overflow:hidden;text-overflow:ellipsis">${esc(g.email)}</div>
      ${g.lastError ? `<div style="font-size:11px;color:var(--danger);margin-top:2px">${esc(g.lastError)}</div>` : ''}
    </div>
    <div class="row" style="gap:5px;flex-shrink:0">
      <button type="button" class="icon-btn soft-primary" data-act="selectAddrFilter" data-v="${esc(g.email)}" data-go="inbox" title="ইনবক্স">${ic('inbox', 'ic-sm')}</button>
      <button type="button" class="icon-btn soft-warn" data-act="openGmailEdit" data-email="${esc(g.email)}" title="লেবেল ও এডিট">${ic('edit', 'ic-sm')}</button>
    </div>
  </div>`;
}

function auto2faStatusHtml() {
  const j = S.auto2fa;
  if (!j) return '';
  const step = j?.step || 0;
  const steps = ['লগইন', 'ভেরিফাই', 'Key এক্সট্র্যাক্ট', 'সক্রিয়'];
  return `<div class="card stack">
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
    ${j.options?.length ? `<div class="stack">${j.options.map((o) => `<button type="button" class="btn sm soft-primary full" data-act="a2faOpt" data-id="${esc(j.id)}" data-idx="${o.idx}">${esc(o.text)}</button>`).join('')}</div>` : ''}
    ${(j.status === 'waiting_code' || j.status === 'waiting_captcha' || j.status === 'waiting_approval') ? `
      <div class="row">
        <input id="a2faChallengeInput" class="input" placeholder="কোড বা ভেরিফিকেশন তথ্য লিখুন…">
        <button type="button" class="btn primary" data-act="a2faSendInput" data-id="${esc(j.id)}">পাঠান</button>
      </div>
      <div class="row">
        <button type="button" class="btn sm soft-primary" style="flex:1" data-act="a2faAction" data-a="continue" data-id="${esc(j.id)}">পরবর্তী ধাপ</button>
        <button type="button" class="btn sm warn" data-act="a2faAction" data-a="alt" data-id="${esc(j.id)}">অন্য উপায়</button>
        <button type="button" class="btn sm danger" data-act="a2faAction" data-a="stop" data-id="${esc(j.id)}">বন্ধ</button>
      </div>` : ''}
    ${j.totpCode ? `<div class="card row-between" style="border-color:var(--ok);background:var(--ok-soft)"><div><div class="muted">লাইভ কোড সেভ হয়েছে</div><div class="mono" style="font-size:22px;font-weight:700">${esc(formatCode(j.totpCode))}</div></div><button type="button" class="btn ok sm" data-act="copyRaw" data-v="${esc(j.totpCode)}">কপি</button></div>` : ''}
  </div>`;
}

function syncHubDom() {
  const bar = $('#hubSubBar');
  const subs = [
    { id: 'addrs', l: `অ্যাড্রেস (${S.addrs.length})` },
    { id: 'gmail', l: `Gmail (${S.gmails.length})` },
    { id: 'auto2fa', l: 'Auto-2FA বট' },
  ];
  if (bar) {
    const bSig = subs.map((x) => `${x.id}:${x.l}:${S.hubSub === x.id}`).join('|');
    if (bar.dataset.sig !== bSig) {
      bar.dataset.sig = bSig;
      bar.innerHTML = subs.map((x) => `<button type="button" class="${S.hubSub === x.id ? 'on' : ''}" data-act="setHubSub" data-s="${x.id}">${x.l}</button>`).join('');
    }
  }

  const body = $('#hubBody');
  if (!body) return;
  if (body.dataset.sub !== S.hubSub) {
    body.dataset.sub = S.hubSub;
    if (S.hubSub === 'addrs') {
      body.innerHTML = `
        <div id="hubPlusHint"></div>
        <div class="row-between">
          <strong style="font-size:14px">অ্যাক্টিভ ঠিকানা সমূহ</strong>
          <button type="button" class="btn sm primary" data-act="openCustomSheet">${ic('plus', 'ic-sm')}<span>নতুন কাস্টম</span></button>
        </div>
        <div class="search-wrap">
          ${ic('search', 'ic-sm')}
          <input id="hubAddrSearch" type="search" placeholder="ঠিকানা বা লেবেল খুঁজুন…" value="${esc(S.hubAddrQuery)}">
        </div>
        <div class="stack" id="hubAddrList"></div>`;
    } else if (S.hubSub === 'gmail') {
      body.innerHTML = `
        <div class="card stack">
          <div class="row-between">
            <div>
              <strong style="font-size:14.5px">Gmail লাইভ OTP সিঙ্ক</strong>
              <div class="muted">ইনবক্স থেকে OTP ও লিংক অটোমেটিক নিয়ে আসবে</div>
            </div>
            <button type="button" class="btn sm soft-primary" data-act="syncGmailNow">${ic('refresh', 'ic-sm')}<span>Sync</span></button>
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
        <div class="stack" id="hubGmailList"></div>`;
    } else {
      body.innerHTML = `
        <div id="hubAuto2faBox"></div>
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
  }

  if (S.hubSub === 'addrs') {
    const ph = $('#hubPlusHint');
    if (ph) {
      const gm = S.gmails[0]?.email || '';
      const pSig = gm;
      if (ph.dataset.sig !== pSig) {
        ph.dataset.sig = pSig;
        ph.innerHTML = gm ? `<div class="card row-between">
          <div style="min-width:0">
            <strong style="font-size:13px">Gmail +Alias জেনারেটর</strong>
            <div class="muted" style="overflow:hidden;text-overflow:ellipsis">${esc(gm)} থেকে আনলিমিটেড অ্যালিয়াস</div>
          </div>
          <button type="button" class="btn sm primary" data-act="genPlusAlias" data-email="${esc(gm)}">তৈরি ও কপি</button>
        </div>` : '';
      }
    }
    const q = S.hubAddrQuery.trim().toLowerCase();
    const list = S.addrs.filter((a) => !q || `${a.addr} ${a.label || ''}`.toLowerCase().includes(q));
    syncKeyedList(
      $('#hubAddrList'),
      list,
      (a) => a.id,
      (a) => `${a.addr}|${a.label || ''}|${a.pinned ? 1 : 0}|${a.expired ? 1 : 0}|${a.count || 0}|${fmtTtl(a)}|${S.selectedAddr === a.addr}`,
      addrCardHtml,
      `<div class="empty"><h3>কোনো ঠিকানা নেই</h3><p>দ্রুত ইনবক্সের জন্য নতুন ঠিকানা তৈরি করুন।</p><button type="button" class="btn primary sm" data-act="quickGen">নতুন মেইল</button></div>`
    );
  } else if (S.hubSub === 'gmail') {
    syncKeyedList(
      $('#hubGmailList'),
      S.gmails,
      (g) => g.email,
      (g) => `${g.email}|${g.label || ''}|${g.status || ''}|${g.twoFaEnabled ? 1 : 0}|${g.lastError || ''}`,
      gmailCardHtml,
      `<div class="card muted">কোনো Gmail অ্যাকাউন্ট যুক্ত নেই। উপর থেকে কানেক্ট করুন।</div>`
    );
  } else {
    const box = $('#hubAuto2faBox');
    if (box) {
      const nextHtml = auto2faStatusHtml();
      const j = S.auto2fa;
      const aSig = j ? `${j.id}|${j.status}|${j.step}|${j.stepTitle || ''}|${j.promptNumber || ''}|${j.screenshot || ''}|${j.totpCode || ''}|${(j.options || []).length}` : '';
      if (box.dataset.sig !== aSig) {
        const ch = $('#a2faChallengeInput');
        const keptVal = ch ? ch.value : '';
        const hadFocus = ch && document.activeElement === ch;
        box.dataset.sig = aSig;
        box.innerHTML = nextHtml;
        if (keptVal && $('#a2faChallengeInput')) {
          $('#a2faChallengeInput').value = keptVal;
          if (hadFocus) $('#a2faChallengeInput').focus();
        }
      }
    }
  }
}

// ---------- Tab 4: Settings (In-Place Zero-Jump) ----------
function mountSettingsHtml() {
  const s = S.settings;
  const toggle = (key, title, desc) => `
    <div class="toggle-row">
      <div class="toggle-info"><strong>${title}</strong><small>${desc}</small></div>
      <button type="button" class="switch" data-act="toggleSetting" data-k="${key}" aria-pressed="false"></button>
    </div>`;

  const ttls = [{ v: 0, l: 'স্থায়ী' }, { v: 10, l: '10m' }, { v: 60, l: '1h' }, { v: 1440, l: '24h' }];
  const styles = [{ v: 'smart', l: 'Smart' }, { v: 'compact', l: 'Compact' }, { v: 'rich', l: 'Rich' }];
  const formats = [{ v: 'spaced', l: '123 456' }, { v: 'plain', l: '123456' }];

  return `
  <section class="view" data-view="settings">
    <div class="card stack">
      <div class="row-between">
        <strong style="font-size:14px">ডিজাইন স্কিন (UI Style)</strong>
        <span class="badge accent" id="skinBadge"></span>
      </div>
      <div class="skin-grid">
        ${SKINS.map((sk) => `
          <button type="button" class="skin-card" data-act="setSkin" data-v="${sk.id}">
            <div class="skin-pv ${sk.pv}"><u></u><u></u></div>
            <span>${sk.l}</span>
          </button>`).join('')}
      </div>
    </div>

    <div class="card stack">
      <div class="row-between">
        <strong style="font-size:14px">থিম পিকচার (২টি ডার্ক · ২টি লাইট)</strong>
        <span class="badge" id="themeBadge"></span>
      </div>
      <div class="theme-groups">
        <div class="theme-subhead">${ic('moon', 'ic-sm')}<span>Dark Mode (2)</span></div>
        <div class="theme-grid">
          ${DARK_THEMES.map((t) => `
            <button type="button" class="theme-card" data-act="setTheme" data-v="${t.id}">
              <span class="theme-pv" style="background:${t.bg};--pv-card:${t.pvCard};--pv-accent:${t.pvAccent}"></span>
              <span class="theme-meta"><strong>${t.l}</strong><small>${t.sub}</small></span>
            </button>`).join('')}
        </div>
        <div class="theme-subhead" style="margin-top:4px">${ic('sun', 'ic-sm')}<span>Light Mode (2)</span></div>
        <div class="theme-grid">
          ${LIGHT_THEMES.map((t) => `
            <button type="button" class="theme-card" data-act="setTheme" data-v="${t.id}">
              <span class="theme-pv is-light" style="background:${t.bg};--pv-card:${t.pvCard};--pv-accent:${t.pvAccent}"></span>
              <span class="theme-meta"><strong>${t.l}</strong><small>${t.sub}</small></span>
            </button>`).join('')}
        </div>
      </div>
    </div>

    <div class="card stack" style="gap:11px">
      <div class="field">
        <label>ডিফল্ট ঠিকানার মেয়াদ (TTL)</label>
        <div class="seg">${ttls.map((t) => `<button type="button" data-act="setSettingChoice" data-k="ttl" data-v="${t.v}">${t.l}</button>`).join('')}</div>
      </div>
      <div class="field">
        <label>বট কার্ড স্টাইল</label>
        <div class="seg">${styles.map((x) => `<button type="button" data-act="setSettingChoice" data-k="style" data-v="${x.v}">${x.l}</button>`).join('')}</div>
      </div>
      <div class="field">
        <label>OTP কোড প্রদর্শন</label>
        <div class="seg">${formats.map((x) => `<button type="button" data-act="setSettingChoice" data-k="otpFormat" data-v="${x.v}">${x.l}</button>`).join('')}</div>
      </div>
    </div>

    <div class="card">
      ${toggle('autoCopy', 'স্মার্ট অটো-কপি OTP', 'নতুন কোড এলেই অটোমেটিক কীবোর্ডে কপি করবে')}
      ${toggle('autoMarkReadOnCopy', 'কপিতে অটো-পঠিত', 'OTP কপি করলে মেইল পঠিত হিসেবে চিহ্নিত হবে')}
      ${toggle('sound', 'সাউন্ড ও হ্যাপটিক ফিডব্যাক', 'নতুন কোড ও বাটন ট্যাপে সূক্ষ্ম ভাইব্রেশন ও চিম সাউন্ড')}
      ${toggle('notify', 'টেলিগ্রাম বট নোটিফিকেশন', 'ইনকামিং মেইল চ্যাটেও সাথে সাথে পাঠাবে')}
      ${toggle('otpOnly', 'শুধু OTP ও ভেরিফাই মেইল', 'অপ্রয়োজনীয় নিউজলেটার নোটিফিকেশন ফিল্টার করবে')}
      ${toggle('compact', 'কম্প্যাক্ট ডেনসিটি', 'এক স্ক্রিনে আরও বেশি মেইল ও 2FA কার্ড দেখাবে')}
      ${toggle('liteBlur', 'পারফরম্যান্স মোড (হালকা ব্লার)', 'হালকা এনিমেশন ও ব্যাটারি সেভ মোড')}
    </div>

    <div class="card stack" id="mutedServicesCard" hidden>
      <strong style="font-size:13.5px">মিউটেড সার্ভিস সমূহ</strong>
      <div class="row wrap" id="mutedChipWrap" style="gap:6px"></div>
    </div>

    <div class="card stack">
      <strong style="font-size:14px">ভল্ট ব্যাকআপ ও পুনরুদ্ধার</strong>
      <div class="muted">সার্ভার রিস্টার্ট হলেও আপনার সব অ্যাড্রেস, 2FA কী এবং সেটিংস নিরাপদে রাখুন।</div>
      <div class="row">
        <button type="button" class="btn primary" style="flex:1" data-act="openBackupSheet">${ic('download', 'ic-sm')}<span>ব্যাকআপ / রিস্টোর</span></button>
        <button type="button" class="btn danger" data-act="openClearInboxSheet">${ic('trash', 'ic-sm')}<span>ইনবক্স ক্লিয়ার</span></button>
      </div>
    </div>
  </section>`;
}

function syncSettingsDom() {
  const s = S.settings;
  const actualTheme = resolveTheme(s.theme);
  const skinBadge = $('#skinBadge');
  if (skinBadge) skinBadge.textContent = SKINS.find((x) => x.id === s.skin)?.l || s.skin;
  const themeBadge = $('#themeBadge');
  if (themeBadge) themeBadge.textContent = ALL_THEMES.find((x) => x.id === actualTheme)?.l || actualTheme;

  $$('[data-act="setSkin"]').forEach((b) => b.classList.toggle('on', b.dataset.v === s.skin));
  $$('[data-act="setTheme"]').forEach((b) => b.classList.toggle('on', b.dataset.v === actualTheme));
  $$('[data-act="toggleSetting"]').forEach((b) => {
    const val = Boolean(s[b.dataset.k]);
    b.classList.toggle('on', val);
    b.setAttribute('aria-pressed', String(val));
  });
  $$('[data-act="setSettingChoice"]').forEach((b) => {
    const k = b.dataset.k;
    const val = String(s[k] ?? '');
    b.classList.toggle('on', b.dataset.v === val);
  });

  const muted = s.muted || [];
  const mc = $('#mutedServicesCard');
  const mw = $('#mutedChipWrap');
  if (mc && mw) {
    mc.hidden = !muted.length;
    const mSig = muted.join('|');
    if (mw.dataset.sig !== mSig) {
      mw.dataset.sig = mSig;
      mw.innerHTML = muted.map((svc) =>
        `<button type="button" class="ic-pill red" data-act="unmuteService" data-svc="${esc(svc)}">${ic('bell-off', 'ic-sm')}<span>${esc(svc)}</span>${ic('x', 'ic-sm')}</button>`
      ).join('');
    }
  }
}

// ---------- Tab 5: Admin Panel (Zero-Jump + User Drawer) ----------
function mountAdminHtml() {
  return `
  <section class="view" data-view="admin">
    <div id="admTopArea" class="stack" style="gap:12px"></div>
    <div class="card stack">
      <strong style="font-size:13.5px">ব্রডকাস্ট ঘোষণা</strong>
      <div class="row">
        <input id="admBcInput" class="input" placeholder="সব ইউজারকে মেসেজ পাঠান…">
        <button type="button" class="btn primary sm" data-act="admBroadcast">${ic('send', 'ic-sm')}<span>পাঠান</span></button>
      </div>
    </div>
    <div class="card stack">
      <div class="row-between">
        <strong style="font-size:13.5px">ইউজার ডিরেক্টরি</strong>
        <span class="badge" id="admUserCount">0</span>
      </div>
      <div class="search-wrap">
        ${ic('search', 'ic-sm')}
        <input id="admUserQuery" type="search" placeholder="নাম, ইউজারনেম বা ID দিয়ে খুঁজুন…" value="${esc(S.admUserQuery)}">
      </div>
      <div class="stack" id="admUserList"></div>
    </div>
  </section>`;
}

function adminUserRowHtml(u) {
  const statusCls = u.status === 'approved' ? 'ok' : u.status === 'banned' ? 'danger' : 'warn';
  return `
  <div class="item-card">
    <div class="item-main">
      <div class="item-title">
        <span>${esc(u.name)}</span>
        <span class="badge ${statusCls}">${esc(u.status)}</span>
      </div>
      <div class="item-sub">
        <span>@${esc(u.username || '—')}</span>
        <span>•</span>
        <span>${u.addresses} addr</span>
        <span>•</span>
        <span>${u.messages} msg</span>
      </div>
    </div>
    <div class="item-actions">
      ${u.status !== 'approved' ? `<button type="button" class="icon-btn soft-ok" data-act="admUser" data-id="${esc(u.id)}" data-ua="approve" title="Approve">${ic('check', 'ic-sm')}</button>` : ''}
      <button type="button" class="btn xs soft-primary" data-act="openAdmUser" data-id="${esc(u.id)}">${ic('sliders', 'ic-sm')}<span>ম্যানেজ</span></button>
    </div>
  </div>`;
}

function syncAdminDom() {
  const a = S.adminData;
  const topArea = $('#admTopArea');
  if (!a) {
    if (topArea && topArea.dataset.sig !== 'loading') {
      topArea.dataset.sig = 'loading';
      topArea.innerHTML = `<div class="card muted">অ্যাডমিন ডেটা লোড হচ্ছে…</div>`;
    }
    return;
  }

  const act = a.activity || [];
  const max = Math.max(1, ...act);
  const tSig = `${a.stats.users}|${a.stats.today}|${a.stats.addresses}|${a.sse?.clients || 0}|${a.titan.online}|${a.openAccess ? 1 : 0}|${Math.floor(a.system.uptime / 60)}|${act.join(',')}`;
  if (topArea && topArea.dataset.sig !== tSig) {
    topArea.dataset.sig = tSig;
    const bars = act.map((v, i) => {
      const h = Math.max(4, Math.round((v / max) * 34));
      return `<rect x="${i * 10}" y="${38 - h}" width="6" height="${h}" rx="2" fill="var(--accent)" opacity="${v ? 0.9 : 0.2}"/>`;
    }).join('');
    topArea.innerHTML = `
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
        <div class="row wrap" style="gap:6px">
          <button type="button" class="btn sm ${a.openAccess ? 'danger' : 'ok'}" data-act="admToggleAccess" data-open="${a.openAccess ? '0' : '1'}">${a.openAccess ? 'Approval Mode চালু' : 'Open Access চালু'}</button>
          <button type="button" class="btn sm soft-primary" data-act="admSweep">${ic('refresh', 'ic-sm')}<span>মেয়াদোত্তীর্ণ ক্লিন</span></button>
        </div>
      </div>`;
  }

  const q = S.admUserQuery.trim().toLowerCase();
  const users = (a.users || []).filter((u) => !q || `${u.name} ${u.username || ''} ${u.id}`.toLowerCase().includes(q));
  const cnt = $('#admUserCount');
  if (cnt) cnt.textContent = String(users.length);
  syncKeyedList(
    $('#admUserList'),
    users.slice(0, 40),
    (u) => u.id,
    (u) => `${u.name}|${u.username || ''}|${u.status}|${u.addresses}|${u.messages}`,
    adminUserRowHtml,
    `<div class="muted">কোনো ইউজার পাওয়া যায়নি</div>`
  );
}

// ---------- Modal Bottom Sheets (Zero Native prompt/confirm) ----------
function openSheet(html) {
  const root = $('#sheetRoot');
  if (!root) return;
  root.innerHTML = `<div class="sheet-backdrop" data-act="closeSheetBackdrop"><div class="sheet" role="dialog"><div class="sheet-handle"></div>${html}</div></div>`;
}
function closeSheet() {
  S.openTotpId = null;
  const root = $('#sheetRoot');
  if (root) root.innerHTML = '';
}

async function openMailSheet(id) {
  openSheet(`<div class="muted" style="padding:20px;text-align:center">লোড হচ্ছে…</div>`);
  try {
    const m = await api(`messages/${id}`);
    const rowMsg = S.msgs.find((x) => x.id === id);
    if (rowMsg && !rowMsg.read) { rowMsg.read = true; S.unread = Math.max(0, S.unread - 1); updateUnreadBadge(); syncInboxDom(); }
    const fmtOtp = m.otp ? (S.settings.otpFormat === 'spaced' ? formatCode(m.otp) : m.otp) : '';
    const svcName = m.service?.name || '';
    const isMuted = svcName && (S.settings.muted || []).includes(svcName);
    const linksHtml = (m.linkList || []).slice(0, 4).map((l) =>
      `<button type="button" class="btn sm primary" data-act="openExtLink" data-url="${esc(l.url)}">${ic('link', 'ic-sm')}<span>${esc(l.label || l.host)}</span></button>`
    ).join('');

    openSheet(`
      <div class="sheet-header">
        <h3 style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(svcName || 'Message')}</h3>
        <div class="row" style="gap:5px">
          <button type="button" class="icon-btn ${m.pinned ? 'soft-warn active' : ''}" data-act="pinMsg" data-id="${esc(m.id)}" data-p="${m.pinned ? '0' : '1'}" title="পিন">${ic('star', 'ic-sm')}</button>
          <button type="button" class="icon-btn soft-primary" data-act="toggleMailRead" data-id="${esc(m.id)}" data-r="0" title="অপঠিত করুন">${ic('mail-open', 'ic-sm')}</button>
          ${svcName ? `<button type="button" class="icon-btn ${isMuted ? 'soft-danger active' : 'soft-warn'}" data-act="toggleMuteSender" data-svc="${esc(svcName)}" title="${isMuted ? 'Unmute' : 'Mute'}">${ic('bell-off', 'ic-sm')}</button>` : ''}
          <button type="button" class="icon-btn soft-danger" data-act="armDelMsg" title="ডিলিট">${ic('trash', 'ic-sm')}</button>
          <button type="button" class="icon-btn" data-act="closeSheet">${ic('x', 'ic-sm')}</button>
        </div>
      </div>

      <div id="mailDelConfirm" class="confirm-box" hidden>
        <p>এই মেইলটি স্থায়ীভাবে মুছে ফেলতে চান?</p>
        <div class="row">
          <button type="button" class="btn sm danger" style="flex:1" data-act="confirmDelMsg" data-id="${esc(m.id)}">হ্যাঁ, মুছে ফেলুন</button>
          <button type="button" class="btn sm" data-act="cancelDelMail">বাতিল</button>
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

      ${linksHtml ? `<div class="row wrap" style="gap:6px">${linksHtml}</div>` : ''}

      <div class="card stack" style="gap:5px;font-size:12px">
        <div><span class="muted">Subject:</span> <strong>${esc(m.subject || '(No subject)')}</strong></div>
        <div><span class="muted">From:</span> ${esc(m.from || '—')}</div>
        <div class="row-between">
          <div style="min-width:0;overflow:hidden;text-overflow:ellipsis"><span class="muted">To:</span> <span class="mono">${esc(m.to)}</span></div>
          <button type="button" class="btn xs soft-primary" data-act="copyMailAll" data-text="${esc(`${m.subject || ''}\nFrom: ${m.from || ''}\nTo: ${m.to}\n\n${m.text || ''}`)}">${ic('copy', 'ic-sm')}<span>Full</span></button>
        </div>
      </div>

      <div class="field">
        <label>পার্সোনাল নোট (ইনবক্সে ট্যাগ হিসেবে থাকবে)</label>
        <div class="row">
          <input id="mailNoteInput" class="input" maxlength="80" placeholder="যেমন: AWS Root Verify, Main IG…" value="${esc(m.note || '')}">
          <button type="button" class="btn sm primary" data-act="saveMailNote" data-id="${esc(m.id)}">সেভ</button>
        </div>
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
    <div class="field">
      <div class="row-between">
        <label>ইউজারনেম (খালি রাখলে র‍্যান্ডম)</label>
        <button type="button" class="btn xs soft-primary" data-act="fillRandName">${ic('sparkles', 'ic-sm')}<span>র‍্যান্ডম নাম</span></button>
      </div>
      <input id="custName" class="input mono" placeholder="e.g. ariyan_dev">
    </div>
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

function openEditAddrSheet(id, startDel = false) {
  const a = S.addrs.find((x) => x.id === id);
  if (!a) return;
  const [curLocal, curDom] = a.addr.split('@');
  S.editDom = curDom || S.domains[0];
  const domChoices = S.domains.includes(curDom) ? S.domains : [curDom, ...S.domains];
  const ttls = [{ v: -1, l: 'অপরিবর্তিত' }, { v: 0, l: 'স্থায়ী' }, { v: 10, l: '10m' }, { v: 60, l: '1h' }, { v: 1440, l: '24h' }];
  const curTtlPick = -1;

  openSheet(`
    <div class="sheet-header">
      <h3>ঠিকানা রিনেম ও এডিট</h3>
      <button type="button" class="icon-btn" data-act="closeSheet">${ic('x', 'ic-sm')}</button>
    </div>

    <div class="field">
      <label>ইমেইল ঠিকানা (রিনেম / ডোমেইন পরিবর্তন)</label>
      <div class="input-group">
        <input id="editAddrLocal" class="mono" value="${esc(curLocal)}" placeholder="username">
        <span class="at-sep">@</span>
        <select id="editAddrDom">
          ${domChoices.map((d) => `<option value="${esc(d)}" ${d === curDom ? 'selected' : ''}>${esc(d)}</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="field">
      <label>লেবেল / ট্যাগ</label>
      <input id="editAddrLabel" class="input" maxlength="40" value="${esc(a.label || '')}" placeholder="যেমন: ChatGPT, Shopping, Main">
    </div>

    <div class="field">
      <label>মেয়াদ (TTL সেট করুন)</label>
      <div class="seg" id="editTtlSeg">
        ${ttls.map((t) => `<button type="button" class="${curTtlPick === t.v ? 'on' : ''}" data-act="pickSeg" data-v="${t.v}">${t.l}</button>`).join('')}
      </div>
    </div>

    <div class="toggle-row" style="padding:4px 0">
      <div class="toggle-info">
        <strong>পুরানো মেইল মাইগ্রেট করুন</strong>
        <small>রিনেম করলে আগের মেইল নতুন ঠিকানায় চলে আসবে</small>
      </div>
      <button type="button" id="editMigrateToggle" class="switch on" data-act="toggleLocalSwitch" aria-pressed="true"></button>
    </div>

    <div class="row">
      <button type="button" class="btn primary" style="flex:1" data-act="submitEditAddr" data-id="${esc(a.id)}">${ic('check', 'ic-sm')}<span>পরিবর্তন সেভ করুন</span></button>
      <button type="button" class="btn soft-ok" data-act="extendAddr" data-id="${esc(a.id)}">+1h</button>
    </div>

    <div id="addrDelBox" class="${startDel ? 'confirm-box' : ''}" ${startDel ? '' : 'hidden'}>
      <p>এই ঠিকানা এবং এর সাথে যুক্ত মেইলগুলো মুছে ফেলতে চান?</p>
      <div class="row">
        <button type="button" class="btn sm danger" style="flex:1" data-act="confirmDelAddr" data-id="${esc(a.id)}">হ্যাঁ, ডিলিট করুন</button>
        <button type="button" class="btn sm" data-act="cancelDelAddr">বাতিল</button>
      </div>
    </div>
    ${startDel ? '' : `<button type="button" class="btn danger full" data-act="armDelAddr">${ic('trash', 'ic-sm')}<span>ঠিকানা ডিলিট করুন</span></button>`}
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
      <button type="button" class="btn soft-primary" style="flex:1" data-act="pasteTotpClip">${ic('copy', 'ic-sm')}<span>পেস্ট করুন</span></button>
    </div>
    <div class="field">
      <label>Secret Key, otpauth:// URI, Google Auth Migration বা Bulk তালিকা</label>
      <textarea id="totpRawInput" class="textarea" placeholder="JBSWY3DPEHPK3PXP\nঅথবা GitHub | JBSW...\nঅথবা otpauth-migration://offline?data=..."></textarea>
    </div>
    <div id="totpParsePreview" class="muted"></div>
    <div class="row">
      <div class="field" style="flex:1"><label>অ্যাকাউন্টের নাম</label><input id="totpNameInput" class="input" placeholder="GitHub Personal"></div>
      <div class="field" style="flex:1"><label>ক্যাটাগরি</label><input id="totpCatInput" class="input" placeholder="Work / Dev" value="General"></div>
    </div>
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
  S.openTotpId = t.id;
  const uri = buildOtpAuthUri(t);
  const cats = ['General', 'Work', 'Social', 'Finance', 'Dev'];
  const codeFmt = formatCode(t.code || '------');

  openSheet(`
    <div class="sheet-header">
      <h3 style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</h3>
      <button type="button" class="icon-btn" data-act="closeSheet">${ic('x', 'ic-sm')}</button>
    </div>

    <div class="card row-between" style="border-color:var(--accent-border);background:var(--accent-soft)">
      <div>
        <div class="muted">লাইভ কোড <span class="badge" id="detailTotpRem" style="margin-left:4px">${t.remaining || 30}s</span></div>
        <div id="detailTotpCode" class="mono" style="font-size:26px;font-weight:700;letter-spacing:0.06em" data-raw="${esc(t.code || '')}">${esc(codeFmt)}</div>
      </div>
      <button type="button" id="detailTotpCopyBtn" class="btn ok" data-act="copyRaw" data-v="${esc(t.code || '')}">${ic('copy', 'ic-sm')}<span>কপি</span></button>
    </div>

    <div class="qr-box">${renderQrSvg(uri, 165)}</div>

    <div class="card row-between">
      <div style="min-width:0;flex:1">
        <div class="muted">Secret Key (${t.algo || 'SHA1'} • ${t.digits || 6}d • ${t.period || 30}s)</div>
        <div id="revealSecretText" class="mono" style="font-size:12px;margin-top:2px;word-break:break-all">${esc(t.masked)}</div>
      </div>
      <div class="row" style="gap:5px">
        <button type="button" class="btn xs soft-primary" data-act="revealTotpSecret" data-s="${esc(t.secret)}">${ic('eye', 'ic-sm')}<span>দেখুন</span></button>
        <button type="button" class="btn xs" data-act="copyRaw" data-v="${esc(uri)}">URI</button>
      </div>
    </div>

    <div class="field"><label>নাম (Rename)</label><input id="editTotpName" class="input" value="${esc(t.name)}"></div>
    <div class="row">
      <div class="field" style="flex:1"><label>Issuer</label><input id="editTotpIssuer" class="input" value="${esc(t.issuer || '')}" placeholder="Google, GitHub…"></div>
      <div class="field" style="flex:1"><label>ক্যাটাগরি</label><input id="editTotpCat" class="input" value="${esc(t.category || 'General')}"></div>
    </div>
    <div class="chip-bar">${cats.map((c) => `<button type="button" class="chip" data-act="pickTotpQuickCat" data-c="${esc(c)}">${c}</button>`).join('')}</div>

    <div class="row">
      <div class="field" style="flex:1"><label>Digits</label><select id="editTotpDigits" class="select"><option value="6" ${(t.digits || 6) === 6 ? 'selected' : ''}>6 Digits</option><option value="8" ${t.digits === 8 ? 'selected' : ''}>8 Digits</option></select></div>
      <div class="field" style="flex:1"><label>Algo</label><select id="editTotpAlgo" class="select"><option value="SHA1" ${t.algo === 'SHA1' ? 'selected' : ''}>SHA1</option><option value="SHA256" ${t.algo === 'SHA256' ? 'selected' : ''}>SHA256</option><option value="SHA512" ${t.algo === 'SHA512' ? 'selected' : ''}>SHA512</option></select></div>
      <div class="field" style="flex:1"><label>Period</label><select id="editTotpPeriod" class="select"><option value="30" ${(t.period || 30) === 30 ? 'selected' : ''}>30s</option><option value="60" ${t.period === 60 ? 'selected' : ''}>60s</option></select></div>
    </div>

    <div class="field"><label>নতুন Secret Key (পরিবর্তন না করলে খালি রাখুন)</label><input id="editTotpSecret" class="input mono" placeholder="ঐচ্ছিক — Base32 Key"></div>

    <div class="row">
      <button type="button" class="btn primary" style="flex:1" data-act="submitEditTotp" data-id="${esc(t.id)}">${ic('check', 'ic-sm')}<span>আপডেট সেভ</span></button>
      <button type="button" class="btn danger" data-act="armDelTotp">${ic('trash', 'ic-sm')}</button>
    </div>

    <div id="totpDelConfirm" class="confirm-box" hidden>
      <p>এই 2FA এন্ট্রি স্থায়ীভাবে ডিলিট করতে চান?</p>
      <div class="row">
        <button type="button" class="btn sm danger" style="flex:1" data-act="confirmDelTotp" data-id="${esc(t.id)}">হ্যাঁ, ডিলিট করুন</button>
        <button type="button" class="btn sm" data-act="cancelDelTotp">বাতিল</button>
      </div>
    </div>
  `);
  tickTotpDom();
}

function openGmailEditSheet(email) {
  const g = S.gmails.find((x) => x.email === email);
  if (!g) return;
  openSheet(`
    <div class="sheet-header"><h3>Gmail ম্যানেজ ও লেবেল</h3><button type="button" class="icon-btn" data-act="closeSheet">${ic('x', 'ic-sm')}</button></div>
    <div class="card"><div class="mono" style="font-size:13px;font-weight:700;word-break:break-all">${esc(g.email)}</div></div>
    <div class="field">
      <label>কাস্টম লেবেল (ট্যাগ)</label>
      <input id="editGmailLabel" class="input" maxlength="40" value="${esc(g.label || '')}" placeholder="যেমন: Personal, Work, OTP Box">
    </div>
    <div class="row">
      <button type="button" class="btn primary" style="flex:1" data-act="saveGmailLabel" data-email="${esc(g.email)}">${ic('check', 'ic-sm')}<span>লেবেল সেভ</span></button>
      <button type="button" class="btn soft-ok" data-act="genPlusAlias" data-email="${esc(g.email)}">+Alias কপি</button>
    </div>
    <div id="gmailDelConfirm" class="confirm-box" hidden>
      <p>এই Gmail সিঙ্ক সংযোগটি সরাতে চান?</p>
      <div class="row">
        <button type="button" class="btn sm danger" style="flex:1" data-act="confirmDelGmail" data-email="${esc(g.email)}">হ্যাঁ, রিমুভ করুন</button>
        <button type="button" class="btn sm" data-act="cancelDelGmail">বাতিল</button>
      </div>
    </div>
    <button type="button" class="btn danger full" data-act="armDelGmail">${ic('trash', 'ic-sm')}<span>Gmail সংযোগ বিচ্ছিন্ন করুন</span></button>
  `);
}

function openClearInboxSheet() {
  openSheet(`
    <div class="sheet-header"><h3>সব মেইল ক্লিয়ার করবেন?</h3><button type="button" class="icon-btn" data-act="closeSheet">${ic('x', 'ic-sm')}</button></div>
    <div class="confirm-box">
      <p>আপনার ইনবক্সের সব মেইল স্থায়ীভাবে মুছে যাবে। 2FA ভল্ট এবং ইমেইল ঠিকানাগুলো অক্ষত থাকবে।</p>
      <div class="row">
        <button type="button" class="btn danger" style="flex:1" data-act="confirmClearInbox">${ic('trash', 'ic-sm')}<span>হ্যাঁ, সব ক্লিয়ার করুন</span></button>
        <button type="button" class="btn" data-act="closeSheet">বাতিল</button>
      </div>
    </div>
  `);
}

function openAdmUserSheet(id) {
  const u = S.adminData?.users?.find((x) => x.id === id);
  if (!u) return;
  openSheet(`
    <div class="sheet-header"><h3>${esc(u.name)}</h3><button type="button" class="icon-btn" data-act="closeSheet">${ic('x', 'ic-sm')}</button></div>
    <div class="card stack" style="gap:4px;font-size:12px">
      <div><span class="muted">Telegram ID:</span> <span class="mono">${esc(u.id)}</span></div>
      <div><span class="muted">Username:</span> @${esc(u.username || '—')}</div>
      <div><span class="muted">Status:</span> <strong>${esc(u.status)}</strong> · ${u.addresses} addresses · ${u.messages} mails</div>
    </div>
    <div class="row wrap" style="gap:6px">
      ${u.status !== 'approved' ? `<button type="button" class="btn sm ok" style="flex:1" data-act="admUserSheet" data-id="${esc(u.id)}" data-ua="approve">✓ Approve</button>` : ''}
      ${u.status !== 'banned' ? `<button type="button" class="btn sm danger" style="flex:1" data-act="admUserSheet" data-id="${esc(u.id)}" data-ua="ban">🚫 Ban</button>` : `<button type="button" class="btn sm ok" style="flex:1" data-act="admUserSheet" data-id="${esc(u.id)}" data-ua="unban">🔓 Unban</button>`}
      <button type="button" class="btn sm warn" data-act="admUserSheet" data-id="${esc(u.id)}" data-ua="clear_mails">🧹 Clear Mails</button>
    </div>
    <div class="field">
      <label>ডিরেক্ট মেসেজ (Telegram DM)</label>
      <div class="row">
        <input id="admDmInput" class="input" placeholder="এই ইউজারকে ব্যক্তিগত মেসেজ লিখুন…">
        <button type="button" class="btn sm primary" data-act="admSendDm" data-id="${esc(u.id)}">${ic('send', 'ic-sm')}</button>
      </div>
    </div>
    <div id="admDelConfirm" class="confirm-box" hidden>
      <p>এই ইউজার ও তার সব ডেটা সিস্টেম থেকে ডিলিট করতে চান?</p>
      <div class="row">
        <button type="button" class="btn sm danger" style="flex:1" data-act="admUserSheet" data-id="${esc(u.id)}" data-ua="delete">হ্যাঁ, ডিলিট ইউজার</button>
        <button type="button" class="btn sm" data-act="cancelAdmDel">বাতিল</button>
      </div>
    </div>
    <button type="button" class="btn danger full" data-act="armAdmDel">${ic('trash', 'ic-sm')}<span>ইউজার ডিলিট করুন</span></button>
  `);
}

function openBackupSheet() {
  openSheet(`
    <div class="sheet-header"><h3>ভল্ট ব্যাকআপ ও রিস্টোর</h3><button type="button" class="icon-btn" data-act="closeSheet">${ic('x', 'ic-sm')}</button></div>
    <div class="field"><label>এনক্রিপশন পাসওয়ার্ড (ঐচ্ছিক — খালি রাখলে প্লেইন JSON)</label><input id="bkpPass" class="input" type="password" placeholder="শক্তিশালী পাসওয়ার্ড দিন…"></div>
    <div class="row">
      <button type="button" class="btn primary" style="flex:1" data-act="exportBackupFile">${ic('download', 'ic-sm')}<span>ব্যাকআপ তৈরি</span></button>
      <button type="button" class="btn soft-primary" data-act="copyBackupJson">${ic('copy', 'ic-sm')}<span>কপি JSON</span></button>
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

  if (act === 'goTab') { hap('light'); setTab(el.dataset.tab); return; }
  if (act === 'closeSheet') { closeSheet(); return; }
  if (act === 'closeSheetBackdrop') { if (ev.target === el) closeSheet(); return; }

  if (act === 'toggleLocalSwitch') {
    const nxt = !el.classList.contains('on');
    el.classList.toggle('on', nxt);
    el.setAttribute('aria-pressed', String(nxt));
    return;
  }

  if (act === 'copyHero') {
    if (!el.dataset.v) { await handleAction({ dataset: { act: 'quickGen' } }, ev); return; }
    const ok = await copyAndNotify(el.dataset.v, `কপি হয়েছে: ${el.dataset.v}`);
    if (ok) { el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 1100); }
    return;
  }
  if (act === 'copyRaw') { await copyAndNotify(el.dataset.v); return; }
  if (act === 'copyMailAll') { await copyAndNotify(el.dataset.text, 'সম্পূর্ণ মেইল কপি হয়েছে'); return; }

  if (act === 'copyMsgOtp') {
    ev.stopPropagation();
    const ok = await copyAndNotify(el.dataset.v, `কোড কপি হয়েছে: ${el.dataset.v}`);
    if (ok && S.settings.autoMarkReadOnCopy && el.dataset.id) {
      api(`messages/${el.dataset.id}`, { method: 'PATCH', body: { read: true } }).then(() => refreshMessages(false)).catch(() => {});
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
        api(`messages/${S.activeOtp.id}`, { method: 'PATCH', body: { read: true } }).then(() => refreshMessages(false)).catch(() => {});
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
        renderView(false);
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
      renderView(false);
      toast(r.prefDomain === -1 ? '🎲 Auto-Random ডোমেইন সক্রিয়' : `✓ ডোমেইন: @${r.domain}`);
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }

  if (act === 'openCustomSheet') { openCustomSheet(); return; }
  if (act === 'fillRandName') {
    const words = ['nova', 'flux', 'zen', 'pulse', 'orbit', 'pixel', 'spark', 'echo', 'atlas', 'vibe'];
    const w = words[Math.floor(Math.random() * words.length)];
    const n = Math.floor(100 + Math.random() * 899);
    if ($('#custName')) $('#custName').value = `${w}${n}`;
    return;
  }
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
        renderView(false);
        await copyAndNotify(d.address.addr, `তৈরি ও কপি: ${d.address.addr}`);
      }
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }

  if (act === 'openEditAddr') {
    openEditAddrSheet(el.dataset.id, el.dataset.del === '1');
    return;
  }
  if (act === 'armDelAddr') { if ($('#addrDelBox')) $('#addrDelBox').hidden = false; return; }
  if (act === 'cancelDelAddr') { if ($('#addrDelBox')) $('#addrDelBox').hidden = true; return; }
  if (act === 'confirmDelAddr') {
    try {
      await api(`addresses/${el.dataset.id}`, { method: 'DELETE' });
      const wasAddr = S.addrs.find((x) => x.id === el.dataset.id)?.addr;
      if (wasAddr && S.selectedAddr === wasAddr) {
        S.selectedAddr = '';
        lsSet('selectedMail', '');
      }
      closeSheet();
      await loadAddresses();
      toast('🗑 অ্যাড্রেস ডিলিট হয়েছে');
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }
  if (act === 'submitEditAddr') {
    const id = el.dataset.id;
    const local = ($('#editAddrLocal')?.value || '').trim().toLowerCase();
    const domain = ($('#editAddrDom')?.value || '').trim().toLowerCase();
    const label = ($('#editAddrLabel')?.value || '').trim();
    const ttlRaw = Number($('#editTtlSeg .on')?.dataset?.v ?? -1);
    const migrateMessages = $('#editMigrateToggle')?.classList.contains('on') ?? true;
    const body = { id, local, domain, label, migrateMessages };
    if (ttlRaw >= 0) body.ttl = ttlRaw;
    try {
      const r = await api('addresses', { method: 'PATCH', body });
      if (r.oldAddr && S.selectedAddr === r.oldAddr && r.address?.addr) {
        S.selectedAddr = r.address.addr;
        lsSet('selectedMail', S.selectedAddr);
      }
      closeSheet();
      await Promise.all([loadAddresses(), refreshMessages(false)]);
      toast(`✓ ঠিকানা আপডেট হয়েছে: ${r.address?.addr || ''}`);
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }

  if (act === 'openQrSheet') { openQrSheet(el.dataset.v); return; }

  if (act === 'selectAddrFilter') {
    S.selectedAddr = el.dataset.v || '';
    lsSet('selectedMail', S.selectedAddr);
    if (el.dataset.go === 'inbox') setTab('inbox');
    else if (S.tab === 'inbox') syncInboxDom();
    refreshMessages(false);
    return;
  }
  if (act === 'setMailFilter') {
    S.mailFilter = el.dataset.f || 'all';
    syncInboxDom();
    refreshMessages(false);
    return;
  }
  if (act === 'clearMailSearch') {
    S.mailQuery = '';
    if ($('#mailSearchInput')) $('#mailSearchInput').value = '';
    if (S.tab === 'inbox') syncInboxDom();
    refreshMessages(false);
    return;
  }
  if (act === 'markAllRead') {
    await api('messages/readall', { method: 'POST' }).catch(() => {});
    S.msgs.forEach((m) => { m.read = true; });
    S.unread = 0;
    updateUnreadBadge();
    if (S.tab === 'inbox') syncInboxDom();
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
    const r = await api(`messages/${el.dataset.id}`, { method: 'PATCH', body: { pinned: p } }).catch(() => null);
    if (r?.message) {
      const row = S.msgs.find((x) => x.id === el.dataset.id);
      if (row) row.pinned = r.message.pinned;
    }
    toast(p ? '★ পিন করা হয়েছে' : '☆ আনপিন হয়েছে');
    openMailSheet(el.dataset.id);
    if (S.tab === 'inbox') syncInboxDom();
    return;
  }
  if (act === 'toggleMailRead') {
    const r = await api(`messages/${el.dataset.id}`, { method: 'PATCH', body: { read: false } }).catch(() => null);
    if (r) {
      const row = S.msgs.find((x) => x.id === el.dataset.id);
      if (row) row.read = false;
      S.unread = r.unread ?? S.unread + 1;
      updateUnreadBadge();
      if (S.tab === 'inbox') syncInboxDom();
      closeSheet();
      toast('📩 অপঠিত হিসেবে চিহ্নিত হয়েছে');
    }
    return;
  }
  if (act === 'toggleMuteSender') {
    const svc = el.dataset.svc;
    if (!svc) return;
    const list = [...(S.settings.muted || [])];
    const idx = list.indexOf(svc);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(svc);
    S.settings.muted = list;
    el.classList.toggle('soft-danger', idx < 0);
    el.classList.toggle('active', idx < 0);
    el.classList.toggle('soft-warn', idx >= 0);
    api('settings', { method: 'POST', body: { muted: list } }).catch(() => {});
    toast(idx < 0 ? `🔕 ${svc} মিউট হয়েছে` : `🔔 ${svc} আনমিউট হয়েছে`);
    return;
  }
  if (act === 'saveMailNote') {
    const note = ($('#mailNoteInput')?.value || '').trim();
    try {
      const r = await api(`messages/${el.dataset.id}`, { method: 'PATCH', body: { note } });
      const row = S.msgs.find((x) => x.id === el.dataset.id);
      if (row && r.message) row.note = r.message.note || '';
      if (S.tab === 'inbox') syncInboxDom();
      toast(note ? '📝 নোট সেভ হয়েছে' : 'নোট মুছে ফেলা হয়েছে');
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }
  if (act === 'armDelMsg') { if ($('#mailDelConfirm')) $('#mailDelConfirm').hidden = false; return; }
  if (act === 'cancelDelMail') { if ($('#mailDelConfirm')) $('#mailDelConfirm').hidden = true; return; }
  if (act === 'confirmDelMsg') {
    await api(`messages/${el.dataset.id}`, { method: 'DELETE' }).catch(() => {});
    S.msgs = S.msgs.filter((m) => m.id !== el.dataset.id);
    closeSheet();
    if (S.tab === 'inbox') syncInboxDom();
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
  if (act === 'setTotpCat') { S.totpCat = el.dataset.c || 'all'; syncTotpDom(); tickTotpDom(); return; }
  if (act === 'clearTotpSearch') {
    S.totpQuery = '';
    if ($('#totpSearchInput')) $('#totpSearchInput').value = '';
    syncTotpDom();
    tickTotpDom();
    return;
  }
  if (act === 'openAddTotpSheet') { openAddTotpSheet(); return; }
  if (act === 'openTotpDetail') { ev.stopPropagation(); openTotpDetailSheet(el.dataset.id); return; }
  if (act === 'pickTotpQuickCat') {
    if ($('#editTotpCat')) $('#editTotpCat').value = el.dataset.c || 'General';
    return;
  }
  if (act === 'revealTotpSecret') {
    if ($('#revealSecretText')) $('#revealSecretText').textContent = el.dataset.s || '';
    await copyAndNotify(el.dataset.s, 'Secret Key কপি হয়েছে');
    return;
  }
  if (act === 'submitEditTotp') {
    const id = el.dataset.id;
    const name = ($('#editTotpName')?.value || '').trim();
    const issuer = ($('#editTotpIssuer')?.value || '').trim();
    const category = ($('#editTotpCat')?.value || 'General').trim();
    const digits = Number($('#editTotpDigits')?.value || 6);
    const algo = $('#editTotpAlgo')?.value || 'SHA1';
    const period = Number($('#editTotpPeriod')?.value || 30);
    const secret = ($('#editTotpSecret')?.value || '').trim();
    if (!name) { toast('⚠️ অ্যাকাউন্টের নাম দিন'); return; }
    const body = { id, name, issuer, category, digits, algo, period };
    if (secret) body.secret = secret;
    try {
      await api('totp', { method: 'PATCH', body });
      closeSheet();
      await loadTotp();
      toast('✓ 2FA তথ্য আপডেট হয়েছে');
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }
  if (act === 'armDelTotp') { if ($('#totpDelConfirm')) $('#totpDelConfirm').hidden = false; return; }
  if (act === 'cancelDelTotp') { if ($('#totpDelConfirm')) $('#totpDelConfirm').hidden = true; return; }
  if (act === 'confirmDelTotp') {
    await api(`totp/${el.dataset.id}`, { method: 'DELETE' }).catch(() => {});
    closeSheet();
    await loadTotp();
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
    const category = ($('#totpCatInput')?.value || 'General').trim();
    const digits = Number($('#totpDigits')?.value || 6);
    const algo = $('#totpAlgo')?.value || 'SHA1';
    if (!raw) { toast('⚠️ Secret বা QR URI দিন'); return; }
    const entries = parseBulkInput(raw, name);
    if (!entries.length) { toast('⚠️ বৈধ 2FA Secret পাওয়া যায়নি'); return; }
    try {
      const body = entries.length === 1
        ? { ...entries[0], name: name || entries[0].name, category, digits, algo }
        : { bulk: entries.map((e) => ({ ...e, category })) };
      await api('totp', { method: 'POST', body });
      closeSheet();
      await loadTotp();
      toast(`✓ ${entries.length}টি 2FA ভল্টে যুক্ত হয়েছে`);
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }

  // Hub & Address Actions
  if (act === 'setHubSub') { S.hubSub = el.dataset.s; syncHubDom(); return; }
  if (act === 'pinAddr') { await api('addresses', { method: 'PATCH', body: { id: el.dataset.id, pinned: el.dataset.p === '1' } }); loadAddresses(); return; }
  if (act === 'extendAddr') { await api('addresses', { method: 'PATCH', body: { id: el.dataset.id, extend: 60 } }); loadAddresses(); toast('✓ মেয়াদ +1h বাড়ানো হয়েছে'); return; }
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
  if (act === 'openGmailEdit') { openGmailEditSheet(el.dataset.email); return; }
  if (act === 'saveGmailLabel') {
    const label = ($('#editGmailLabel')?.value || '').trim();
    try {
      await api('gmail', { method: 'PATCH', body: { email: el.dataset.email, label } });
      closeSheet();
      await loadGmails();
      toast('✓ Gmail লেবেল আপডেট হয়েছে');
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }
  if (act === 'armDelGmail') { if ($('#gmailDelConfirm')) $('#gmailDelConfirm').hidden = false; return; }
  if (act === 'cancelDelGmail') { if ($('#gmailDelConfirm')) $('#gmailDelConfirm').hidden = true; return; }
  if (act === 'confirmDelGmail') {
    await api(`gmail?email=${encodeURIComponent(el.dataset.email)}`, { method: 'DELETE' }).catch(() => {});
    closeSheet();
    await loadGmails();
    toast('🗑 Gmail সংযোগ সরানো হয়েছে');
    return;
  }

  if (act === 'startAuto2fa') {
    const email = ($('#a2faEmail')?.value || '').trim();
    const password = ($('#a2faPass')?.value || '').trim();
    const recoveryEmail = ($('#a2faRec')?.value || '').trim();
    try {
      const r = await api('gmail/auto2fa', { method: 'POST', body: { email, password, recoveryEmail } });
      S.auto2fa = r.job;
      if (r.items) S.totp = r.items;
      if (S.tab === 'hub') syncHubDom();
      toast('🤖 Auto 2FA শুরু হয়েছে');
    } catch (e) { toast('⚠️ ' + e.message); }
    return;
  }
  if (act === 'a2faAction') {
    const r = await api('gmail/auto2fa', { method: 'POST', body: { jobId: el.dataset.id, action: el.dataset.a } }).catch(() => null);
    if (r?.job) { S.auto2fa = r.job; if (S.tab === 'hub') syncHubDom(); }
    return;
  }
  if (act === 'a2faOpt') {
    const r = await api('gmail/auto2fa', { method: 'POST', body: { jobId: el.dataset.id, action: 'option', optionIdx: Number(el.dataset.idx) } }).catch(() => null);
    if (r?.job) { S.auto2fa = r.job; if (S.tab === 'hub') syncHubDom(); }
    return;
  }
  if (act === 'a2faSendInput') {
    const text = ($('#a2faChallengeInput')?.value || '').trim();
    if (!text) return;
    const r = await api('gmail/auto2fa', { method: 'POST', body: { jobId: el.dataset.id, action: 'input', text } }).catch(() => null);
    if (r?.job) { S.auto2fa = r.job; if (S.tab === 'hub') syncHubDom(); }
    return;
  }

  // Settings & Backup (In-Place Zero-Jump)
  if (act === 'setSkin') {
    hap('light');
    S.settings.skin = el.dataset.v;
    applyTheme();
    syncSettingsDom();
    api('settings', { method: 'POST', body: { skin: S.settings.skin } }).catch(() => {});
    return;
  }
  if (act === 'setTheme') {
    hap('light');
    S.settings.theme = el.dataset.v;
    applyTheme();
    syncSettingsDom();
    api('settings', { method: 'POST', body: { theme: S.settings.theme } }).catch(() => {});
    return;
  }
  if (act === 'toggleSetting') {
    hap('light');
    const k = el.dataset.k;
    S.settings[k] = !S.settings[k];
    applyTheme();
    syncSettingsDom();
    api('settings', { method: 'POST', body: { [k]: S.settings[k] } }).catch(() => {});
    return;
  }
  if (act === 'setSettingChoice') {
    hap('light');
    const k = el.dataset.k;
    const rawVal = el.dataset.v;
    const val = k === 'ttl' ? Number(rawVal) : rawVal;
    S.settings[k] = val;
    syncSettingsDom();
    lsSet('savedSettings', JSON.stringify(S.settings));
    api('settings', { method: 'POST', body: { [k]: val } }).catch(() => {});
    return;
  }
  if (act === 'unmuteService') {
    const svc = el.dataset.svc;
    S.settings.muted = (S.settings.muted || []).filter((x) => x !== svc);
    syncSettingsDom();
    api('settings', { method: 'POST', body: { muted: S.settings.muted } }).catch(() => {});
    toast(`🔔 ${svc} আনমিউট হয়েছে`);
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
  if (act === 'openClearInboxSheet') { openClearInboxSheet(); return; }
  if (act === 'confirmClearInbox') {
    await api('messages', { method: 'DELETE' });
    S.msgs = []; S.unread = 0; S.stats.total = 0; S.stats.unread = 0;
    updateUnreadBadge();
    closeSheet();
    toast('🧹 ইনবক্স খালি হয়েছে');
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
  if (act === 'openAdmUser') { openAdmUserSheet(el.dataset.id); return; }
  if (act === 'armAdmDel') { if ($('#admDelConfirm')) $('#admDelConfirm').hidden = false; return; }
  if (act === 'cancelAdmDel') { if ($('#admDelConfirm')) $('#admDelConfirm').hidden = true; return; }
  if (act === 'admUserSheet') {
    await api('admin/user', { method: 'POST', body: { id: el.dataset.id, action: el.dataset.ua } });
    closeSheet();
    await loadAdmin();
    toast('✓ ইউজার স্ট্যাটাস আপডেট হয়েছে');
    return;
  }
  if (act === 'admSendDm') {
    const text = ($('#admDmInput')?.value || '').trim();
    if (!text) { toast('⚠️ মেসেজ লিখুন'); return; }
    await api('admin/user', { method: 'POST', body: { id: el.dataset.id, action: 'message', text } });
    if ($('#admDmInput')) $('#admDmInput').value = '';
    toast('✓ DM পাঠানো হয়েছে');
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
    if ($('#mailClearBtn')) $('#mailClearBtn').hidden = !t.value;
    clearTimeout(t._tm);
    t._tm = setTimeout(() => refreshMessages(false), 180);
  } else if (t.id === 'totpSearchInput') {
    S.totpQuery = t.value;
    if ($('#totpList')) { syncTotpDom(); tickTotpDom(); }
  } else if (t.id === 'hubAddrSearch') {
    S.hubAddrQuery = t.value;
    if ($('#hubAddrList')) syncHubDom();
  } else if (t.id === 'admUserQuery') {
    S.admUserQuery = t.value;
    if ($('#admUserList')) syncAdminDom();
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
    S.settings.theme = resolveTheme(S.settings.theme);
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
    try { tg.onEvent?.('themeChanged', () => applyTheme()); } catch {}
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
