/* Ariyan Temp Mail — Browser Extension Popup Controller
 * Pure Vanilla JavaScript Manifest V3
 * Inspired by official temp-mail.io UX
 */

(function () {
  'use strict';

  // --- Constants & Defaults ---
  const DEFAULT_SERVER = 'https://temp-mail-pks1.onrender.com';

  // --- App State ---
  const state = {
    clientId: '',
    serverUrl: DEFAULT_SERVER,
    activeAddr: '',
    activeAddrId: '',
    activeAddrObj: null,
    recentAddrs: [],
    domains: ['safix.tech', 'mdsafiislam.tech'],
    prefDomain: -1,
    messages: [],
    unreadCount: 0,
    activeMsg: null,
    filter: 'all',
    searchQuery: '',
    autoCopy: true,
    notify: true,
    sound: true,
    theme: 'light',
    selectedTtl: 0,
    sseToken: '',
    evtSource: null,
    pollTimer: null,
  };

  // --- Audio Synthesizer (Zero External Assets) ---
  let audioCtx = null;
  function playChime() {
    if (!state.sound) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!audioCtx) audioCtx = new AudioCtx();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const now = audioCtx.currentTime;
      const osc1 = audioCtx.createOscillator();
      const osc2 = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc1.type = 'sine';
      osc2.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now); // D5
      osc1.frequency.exponentialRampToValueAtTime(880.00, now + 0.12); // A5

      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(880.00, now + 0.08);
      osc2.frequency.exponentialRampToValueAtTime(1174.66, now + 0.25); // D6

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.2, now + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(audioCtx.destination);

      osc1.start(now);
      osc2.start(now + 0.06);
      osc1.stop(now + 0.35);
      osc2.stop(now + 0.35);
    } catch (e) {
      // Audio autoplay restrictions or headless catch
    }
  }

  // --- DOM Elements Cache ---
  const el = {
    // Header
    liveDot: document.getElementById('liveDot'),
    liveStatus: document.getElementById('liveStatus'),
    btnTestOtp: document.getElementById('btnTestOtp'),
    btnRefresh: document.getElementById('btnRefresh'),
    btnSettings: document.getElementById('btnSettings'),

    // Hero
    domainBadge: document.getElementById('domainBadge'),
    ttlBadge: document.getElementById('ttlBadge'),
    labelBadge: document.getElementById('labelBadge'),
    btnSwitchDomain: document.getElementById('btnSwitchDomain'),
    addrBox: document.getElementById('addrBox'),
    activeAddr: document.getElementById('activeAddr'),
    copyBadge: document.getElementById('copyBadge'),
    copyHint: document.getElementById('copyHint'),
    btnQuickGen: document.getElementById('btnQuickGen'),
    btnCustomSheet: document.getElementById('btnCustomSheet'),
    btnOpenWeb: document.getElementById('btnOpenWeb'),
    btnQrSheet: document.getElementById('btnQrSheet'),
    recentBar: document.getElementById('recentBar'),
    recentChips: document.getElementById('recentChips'),

    // Search & Filters
    searchInput: document.getElementById('searchInput'),
    searchClear: document.getElementById('searchClear'),
    btnMarkAllRead: document.getElementById('btnMarkAllRead'),
    filterBar: document.getElementById('filterBar'),
    countAll: document.getElementById('countAll'),
    countUnread: document.getElementById('countUnread'),

    // Mail list
    mailList: document.getElementById('mailList'),
    emptyState: document.getElementById('emptyState'),
    btnEmptyTest: document.getElementById('btnEmptyTest'),

    // Reader Drawer
    readerDrawer: document.getElementById('readerDrawer'),
    readerTitle: document.getElementById('readerTitle'),
    readerBody: document.getElementById('readerBody'),
    btnBackToInbox: document.getElementById('btnBackToInbox'),
    btnPinMsg: document.getElementById('btnPinMsg'),
    btnDeleteMsg: document.getElementById('btnDeleteMsg'),

    // Custom Email Drawer
    customDrawer: document.getElementById('customDrawer'),
    btnCloseCustom: document.getElementById('btnCloseCustom'),
    custLocalInput: document.getElementById('custLocalInput'),
    btnRandLocal: document.getElementById('btnRandLocal'),
    custDomainSelect: document.getElementById('custDomainSelect'),
    custLabelInput: document.getElementById('custLabelInput'),
    custTtlSeg: document.getElementById('custTtlSeg'),
    btnSubmitCustom: document.getElementById('btnSubmitCustom'),

    // Domain Drawer
    domainDrawer: document.getElementById('domainDrawer'),
    btnCloseDomain: document.getElementById('btnCloseDomain'),
    domainList: document.getElementById('domainList'),

    // QR Modal
    qrModal: document.getElementById('qrModal'),
    btnCloseQr: document.getElementById('btnCloseQr'),
    qrContainer: document.getElementById('qrContainer'),
    qrText: document.getElementById('qrText'),
    btnCopyFromQr: document.getElementById('btnCopyFromQr'),

    // Settings Drawer
    settingsDrawer: document.getElementById('settingsDrawer'),
    btnCloseSettings: document.getElementById('btnCloseSettings'),
    settingServerUrl: document.getElementById('settingServerUrl'),
    toggleAutoCopy: document.getElementById('toggleAutoCopy'),
    toggleNotify: document.getElementById('toggleNotify'),
    toggleSound: document.getElementById('toggleSound'),
    themeSeg: document.getElementById('themeSeg'),
    clientIdLabel: document.getElementById('clientIdLabel'),
    btnSaveSettings: document.getElementById('btnSaveSettings'),
    btnClearInbox: document.getElementById('btnClearInbox'),

    // Toast
    toast: document.getElementById('toast'),
  };

  // --- Toast Helper ---
  let toastTimeout = null;
  function showToast(text, duration = 2400) {
    if (!el.toast) return;
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      el.toast.hidden = true;
    }, duration);
  }

  // --- Storage Wrappers ---
  function getStorage(keys) {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get(keys, (data) => resolve(data || {}));
      } else {
        const out = {};
        keys.forEach((k) => {
          try {
            const v = localStorage.getItem(k);
            if (v !== null) out[k] = JSON.parse(v);
          } catch {}
        });
        resolve(out);
      }
    });
  }

  function setStorage(data) {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set(data, () => resolve());
      } else {
        Object.keys(data).forEach((k) => {
          try {
            localStorage.setItem(k, JSON.stringify(data[k]));
          } catch {}
        });
        resolve();
      }
    });
  }

  // --- API Client ---
  async function api(path, options = {}) {
    const base = (state.serverUrl || DEFAULT_SERVER).replace(/\/+$/, '');
    const url = `${base}${path.startsWith('/') ? path : '/' + path}`;

    const headers = Object.assign(
      {
        'Content-Type': 'application/json',
        'x-ext-id': state.clientId,
      },
      options.headers || {}
    );

    try {
      const res = await fetch(url, { ...options, headers });
      if (!res.ok) {
        let errData = {};
        try { errData = await res.json(); } catch {}
        const msg = errData.error || `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return await res.json();
    } catch (err) {
      console.warn(`[Temp Mail API] Error on ${path}:`, err.message);
      throw err;
    }
  }

  // --- Brand Detection & Metadata ---
  const KNOWN_BRANDS = [
    { match: /telegram/i, name: 'Telegram', bg: '#229ed9', fg: '#fff', abbr: 'TG' },
    { match: /google|gmail/i, name: 'Google', bg: '#ea4335', fg: '#fff', abbr: 'G' },
    { match: /github/i, name: 'GitHub', bg: '#24292e', fg: '#fff', abbr: 'GH' },
    { match: /discord/i, name: 'Discord', bg: '#5865f2', fg: '#fff', abbr: 'DC' },
    { match: /openai|chatgpt/i, name: 'OpenAI', bg: '#10a37f', fg: '#fff', abbr: 'AI' },
    { match: /netflix/i, name: 'Netflix', bg: '#e50914', fg: '#fff', abbr: 'NF' },
    { match: /facebook|meta/i, name: 'Meta', bg: '#1877f2', fg: '#fff', abbr: 'FB' },
    { match: /twitter|x\.com/i, name: 'X (Twitter)', bg: '#000000', fg: '#fff', abbr: '𝕏' },
    { match: /amazon|aws/i, name: 'Amazon', bg: '#ff9900', fg: '#111', abbr: 'AZ' },
    { match: /steam/i, name: 'Steam', bg: '#171a21', fg: '#66c0f4', abbr: 'ST' },
    { match: /spotify/i, name: 'Spotify', bg: '#1ed760', fg: '#000', abbr: 'SF' },
    { match: /microsoft|outlook/i, name: 'Microsoft', bg: '#00a4ef', fg: '#fff', abbr: 'MS' },
    { match: /apple|icloud/i, name: 'Apple', bg: '#555555', fg: '#fff', abbr: 'AP' },
    { match: /paypal/i, name: 'PayPal', bg: '#003087', fg: '#fff', abbr: 'PP' },
    { match: /stripe/i, name: 'Stripe', bg: '#635bff', fg: '#fff', abbr: 'ST' },
  ];

  function detectBrand(sender, subject, service) {
    if (service && service.name) {
      const match = KNOWN_BRANDS.find((b) => b.match.test(service.name));
      if (match) return match;
      return {
        name: service.name,
        bg: '#6d28d9',
        fg: '#fff',
        abbr: (service.name.slice(0, 2) || 'ML').toUpperCase(),
      };
    }
    const combined = `${sender || ''} ${subject || ''}`;
    for (const b of KNOWN_BRANDS) {
      if (b.match.test(combined)) return b;
    }
    // Default Fallback
    const cleanFrom = (sender || 'Mail').replace(/^[^a-zA-Z0-9]+/, '');
    const abbr = cleanFrom.slice(0, 2).toUpperCase() || 'ML';
    let hash = 0;
    for (let i = 0; i < cleanFrom.length; i++) hash = (hash * 31 + cleanFrom.charCodeAt(i)) & 0xffffff;
    const hue = Math.abs(hash) % 360;
    return {
      name: sender || 'Sender',
      bg: `hsl(${hue}, 65%, 45%)`,
      fg: '#ffffff',
      abbr,
    };
  }

  // --- Relative Time Formatter ---
  function formatRelativeTime(ts) {
    if (!ts) return '';
    const now = Date.now();
    const diff = Math.max(0, Math.floor((now - ts) / 1000));
    if (diff < 10) return 'এইমাত্র';
    if (diff < 60) return `${diff}s আগে`;
    const m = Math.floor(diff / 60);
    if (m < 60) return `${m}m আগে`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h আগে`;
    const d = Math.floor(h / 24);
    if (d === 1) return 'গতকাল';
    if (d < 7) return `${d} দিন আগে`;
    const date = new Date(ts);
    return `${date.getDate()}/${date.getMonth() + 1}`;
  }

  // --- Inline Compact QR Code Generator (SVG Vector) ---
  function renderSvgQr(text, containerEl) {
    if (!containerEl) return;
    try {
      const qrData = encodeSimpleQr(text);
      const size = qrData.length;
      let pathData = '';
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (qrData[r][c]) {
            pathData += `M${c},${r}h1v1h-1z `;
          }
        }
      }
      containerEl.innerHTML = `
        <svg viewBox="0 0 ${size} ${size}" width="160" height="160" shape-rendering="crispEdges">
          <rect width="100%" height="100%" fill="#ffffff" rx="8" />
          <path d="${pathData}" fill="#0d111e" />
        </svg>
      `;
    } catch {
      containerEl.innerHTML = `<div style="font-size:12px;color:var(--text-3);padding:20px;">${escapeHtml(text)}</div>`;
    }
  }

  function encodeSimpleQr(text) {
    const N = 25; // 25x25 grid
    const m = Array.from({ length: N }, () => Array(N).fill(false));

    function setFinder(r0, c0) {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const isOuter = r === 0 || r === 6 || c === 0 || c === 6;
          const isInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          m[r0 + r][c0 + c] = isOuter || isInner;
        }
      }
    }
    setFinder(0, 0);
    setFinder(0, N - 7);
    setFinder(N - 7, 0);

    for (let i = 8; i < N - 8; i++) {
      m[6][i] = i % 2 === 0;
      m[i][6] = i % 2 === 0;
    }
    const ar = 18, ac = 18;
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const isOut = Math.abs(r) === 2 || Math.abs(c) === 2;
        const isIn = r === 0 && c === 0;
        m[ar + r][ac + c] = isOut || isIn;
      }
    }

    const bytes = new TextEncoder().encode(text);
    let byteIdx = 0, bitIdx = 0;
    for (let c = N - 1; c > 0; c -= 2) {
      if (c === 6) c--;
      for (let row = 0; row < N; row++) {
        const r = ((c + 1) / 2) % 2 === 0 ? row : N - 1 - row;
        for (let dc = 0; dc < 2; dc++) {
          const cc = c - dc;
          const inF1 = r < 9 && cc < 9;
          const inF2 = r < 9 && cc >= N - 8;
          const inF3 = r >= N - 8 && cc < 9;
          const inAlign = r >= 16 && r <= 20 && cc >= 16 && cc <= 20;
          const inTiming = r === 6 || cc === 6;
          if (inF1 || inF2 || inF3 || inAlign || inTiming) continue;

          let bit = false;
          if (byteIdx < bytes.length) {
            bit = Boolean((bytes[byteIdx] >> (7 - bitIdx)) & 1);
            bitIdx++;
            if (bitIdx === 8) {
              bitIdx = 0;
              byteIdx++;
            }
          } else {
            bit = ((r + cc) % 2 === 0) ^ ((r * cc) % 3 === 0);
          }
          m[r][cc] = bit;
        }
      }
    }
    return m;
  }

  // --- HTML Sanitizer / Escaper ---
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // --- Render Active Address Hero Card ---
  function renderHeroCard() {
    const addr = state.activeAddr || 'কোনো ঠিকানা নেই';
    el.activeAddr.textContent = addr;

    const parts = addr.split('@');
    const domain = parts[1] ? `@${parts[1]}` : (state.domains[0] ? `@${state.domains[0]}` : '@safix.tech');
    el.domainBadge.textContent = domain;

    // Check TTL / Expiry
    if (state.activeAddrObj && state.activeAddrObj.ttl > 0) {
      el.ttlBadge.textContent = `${state.activeAddrObj.ttl}m`;
      el.ttlBadge.className = 'badge warn';
      el.ttlBadge.hidden = false;
    } else {
      el.ttlBadge.textContent = 'স্থায়ী';
      el.ttlBadge.className = 'badge ok';
      el.ttlBadge.hidden = false;
    }

    if (state.activeAddrObj && state.activeAddrObj.label) {
      el.labelBadge.textContent = state.activeAddrObj.label;
      el.labelBadge.hidden = false;
    } else {
      el.labelBadge.hidden = true;
    }

    // Render Recent Address Chips
    renderRecentChips();
  }

  function renderRecentChips() {
    const list = state.recentAddrs || [];
    if (list.length <= 1) {
      el.recentBar.hidden = true;
      return;
    }
    el.recentBar.hidden = false;
    el.recentChips.innerHTML = list
      .map((a) => {
        const isCurrent = a === state.activeAddr;
        const short = a.split('@')[0];
        return `
          <button type="button" class="chip ${isCurrent ? 'on' : ''}" data-addr="${escapeHtml(a)}">
            ${escapeHtml(short)}
          </button>
        `;
      })
      .join('');
  }

  // --- Render Mail List ---
  function renderMailList() {
    const query = state.searchQuery.trim().toLowerCase();
    const filter = state.filter;

    let items = state.messages.slice();

    // Filter by tab
    if (filter === 'unread') {
      items = items.filter((m) => !m.read);
    } else if (filter === 'otp') {
      items = items.filter((m) => Boolean(m.otp));
    } else if (filter === 'link') {
      items = items.filter((m) => (m.links && m.links.length > 0) || (m.linkList && m.linkList.length > 0));
    }

    // Filter by query
    if (query) {
      items = items.filter((m) => {
        const subject = (m.subject || '').toLowerCase();
        const from = (m.from || '').toLowerCase();
        const otp = (m.otp || '').toLowerCase();
        const preview = (m.preview || m.text || '').toLowerCase();
        const to = (m.to || '').toLowerCase();
        return subject.includes(query) || from.includes(query) || otp.includes(query) || preview.includes(query) || to.includes(query);
      });
    }

    // Update Counts
    const unreadTotal = state.messages.filter((m) => !m.read).length;
    el.countAll.textContent = state.messages.length;
    el.countUnread.textContent = unreadTotal;

    if (items.length === 0) {
      el.emptyState.hidden = false;
      const existingItems = el.mailList.querySelectorAll('.mail-item');
      existingItems.forEach((x) => x.remove());
      return;
    }

    el.emptyState.hidden = true;

    // Render HTML items
    const rowsHtml = items
      .map((msg) => {
        const brand = detectBrand(msg.from, msg.subject, msg.service);
        const relTime = formatRelativeTime(msg.date);
        const hasOtp = Boolean(msg.otp);
        const isUnread = !msg.read;
        const isPinned = Boolean(msg.pinned);

        return `
          <article class="mail-item ${isUnread ? 'unread' : ''}" data-id="${escapeHtml(msg.id)}">
            <div class="mail-avatar" style="background:${brand.bg};color:${brand.fg}">
              ${escapeHtml(brand.abbr)}
            </div>
            <div class="mail-body">
              <div class="mail-meta">
                <span class="sender-name">${escapeHtml(brand.name || msg.from)}</span>
                <span class="mail-time">${escapeHtml(relTime)}</span>
              </div>
              <div class="mail-subject">${escapeHtml(msg.subject || '(কোনো বিষয় নেই)')}</div>
              <div class="mail-preview">${escapeHtml(msg.preview || msg.text || '')}</div>
              ${
                hasOtp
                  ? `
                <div class="mail-chips">
                  <div class="otp-pill" data-otp="${escapeHtml(msg.otp)}" title="OTP কোড এক ক্লিকে কপি করুন">
                    <svg viewBox="0 0 24 24" class="ic"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    <strong>${escapeHtml(msg.otp)}</strong>
                    <span class="otp-action">কপি</span>
                  </div>
                  ${msg.links?.length ? '<span class="chip-sm">🔗 ভেরিফাই লিংক</span>' : ''}
                  ${isPinned ? '<span class="chip-sm pin">📌 পিন করা</span>' : ''}
                </div>
              `
                  : `
                ${(msg.links?.length || isPinned) ? `
                  <div class="mail-chips">
                    ${msg.links?.length ? '<span class="chip-sm">🔗 ভেরিফাই লিংক</span>' : ''}
                    ${isPinned ? '<span class="chip-sm pin">📌 পিন করা</span>' : ''}
                  </div>
                ` : ''}
              `
              }
            </div>
          </article>
        `;
      })
      .join('');

    // Update mail list while keeping empty state node
    const oldRows = el.mailList.querySelectorAll('.mail-item');
    oldRows.forEach((r) => r.remove());
    el.emptyState.insertAdjacentHTML('afterend', rowsHtml);
  }

  // --- Render Message Reader Drawer ---
  function openReader(msg) {
    state.activeMsg = msg;
    el.readerTitle.textContent = msg.service?.name || msg.from || 'বার্তা বিবরণ';
    el.btnPinMsg.classList.toggle('active', Boolean(msg.pinned));

    const brand = detectBrand(msg.from, msg.subject, msg.service);
    const dateFormatted = new Date(msg.date).toLocaleString('bn-BD', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    const verifyLink = msg.links?.[0] || msg.linkList?.[0] || '';

    let htmlContent = `
      <div class="reader-meta-card">
        <div class="row" style="align-items:center;gap:10px;">
          <div class="mail-avatar" style="background:${brand.bg};color:${brand.fg};width:38px;height:38px;font-size:14px">
            ${escapeHtml(brand.abbr)}
          </div>
          <div>
            <div style="font-weight:700;font-size:14px;color:var(--text-1);">${escapeHtml(brand.name || msg.from)}</div>
            <div class="mono-sub" style="font-size:11px;color:var(--text-3);">${escapeHtml(msg.from)}</div>
          </div>
        </div>
        <div class="reader-details-grid">
          <div><span style="color:var(--text-3)">কার কাছে:</span> <code>${escapeHtml(msg.to)}</code></div>
          <div><span style="color:var(--text-3)">তারিখ:</span> ${escapeHtml(dateFormatted)}</div>
        </div>
        <h4 style="margin:10px 0 0;font-size:14px;font-weight:700;color:var(--text-1);">${escapeHtml(msg.subject || '(কোনো বিষয় নেই)')}</h4>
      </div>
    `;

    // Big OTP Highlight Box
    if (msg.otp) {
      htmlContent += `
        <div class="otp-hero-card">
          <div class="otp-hero-label">🔑 সিকিউরিটি ভেরিফিকেশন কোড (OTP)</div>
          <div class="otp-hero-row">
            <span class="otp-hero-code" id="readerOtpCode">${escapeHtml(msg.otp)}</span>
            <button type="button" class="btn primary sm" id="btnReaderCopyOtp">
              <svg viewBox="0 0 24 24" class="ic"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span>কপি করুন</span>
            </button>
          </div>
        </div>
      `;
    }

    // Magic Verify Link Button
    if (verifyLink) {
      htmlContent += `
        <div class="verify-link-card">
          <a href="${escapeHtml(verifyLink)}" target="_blank" rel="noopener noreferrer" class="btn ok full" id="btnMagicVerify">
            <svg viewBox="0 0 24 24" class="ic"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            <span>ভেরিফাই লিংকে যান (Open Link)</span>
          </a>
        </div>
      `;
    }

    // View toggle & Message Body
    const cleanText = msg.text || msg.preview || '';
    const hasHtml = Boolean(msg.html);

    htmlContent += `
      <div class="body-view-controls">
        <span>বার্তা বিষয়বস্তু</span>
        ${
          hasHtml
            ? `
          <div class="seg sm" id="bodyToggleSeg">
            <button type="button" class="on" data-mode="text">Text</button>
            <button type="button" data-mode="html">HTML</button>
          </div>
        `
            : ''
        }
      </div>
      <div class="message-body-box" id="msgBodyContainer">
        <pre class="body-text">${escapeHtml(cleanText)}</pre>
      </div>
    `;

    // Private Note field
    htmlContent += `
      <div class="note-box">
        <label>📝 ব্যক্তিগত নোট (Private Note)</label>
        <div class="row" style="gap:6px">
          <input type="text" id="readerNoteInput" value="${escapeHtml(msg.note || '')}" placeholder="যেমন: কাজের জন্য অ্যাকাউন্ট, পাসওয়ার্ড মনে রাখবেন…">
          <button type="button" class="btn xs soft-primary" id="btnSaveNote">সেভ</button>
        </div>
      </div>
    `;

    el.readerBody.innerHTML = htmlContent;
    el.readerDrawer.hidden = false;

    // Attach Reader Event Handlers
    const btnReaderCopyOtp = document.getElementById('btnReaderCopyOtp');
    if (btnReaderCopyOtp) {
      btnReaderCopyOtp.addEventListener('click', () => {
        navigator.clipboard.writeText(msg.otp).then(() => {
          showToast(`✓ OTP কোড ${msg.otp} কপি করা হয়েছে!`);
        });
      });
    }

    const bodyToggleSeg = document.getElementById('bodyToggleSeg');
    const msgBodyContainer = document.getElementById('msgBodyContainer');
    if (bodyToggleSeg && msgBodyContainer) {
      bodyToggleSeg.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        bodyToggleSeg.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
        btn.classList.add('on');
        const mode = btn.dataset.mode;
        if (mode === 'html') {
          const iframe = document.createElement('iframe');
          iframe.className = 'html-frame';
          iframe.sandbox = 'allow-same-origin';
          msgBodyContainer.innerHTML = '';
          msgBodyContainer.appendChild(iframe);
          const doc = iframe.contentDocument || iframe.contentWindow.document;
          doc.open();
          doc.write(`
            <!doctype html>
            <html>
            <head>
              <meta charset="utf-8">
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px; line-height: 1.5; color: #1e293b; padding: 12px; margin: 0; word-break: break-word; }
                a { color: #6d28d9; text-decoration: underline; }
                img { max-width: 100%; height: auto; }
              </style>
            </head>
            <body>${msg.html}</body>
            </html>
          `);
          doc.close();
        } else {
          msgBodyContainer.innerHTML = `<pre class="body-text">${escapeHtml(cleanText)}</pre>`;
        }
      });
    }

    const btnSaveNote = document.getElementById('btnSaveNote');
    const readerNoteInput = document.getElementById('readerNoteInput');
    if (btnSaveNote && readerNoteInput) {
      btnSaveNote.addEventListener('click', async () => {
        const note = readerNoteInput.value.trim();
        try {
          await api(`/api/messages/${msg.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ note }),
          });
          msg.note = note;
          showToast('✓ নোট সংরক্ষিত হয়েছে!');
        } catch {
          showToast('নোট সেভ করা যায়নি');
        }
      });
    }

    // Mark as read on server
    if (!msg.read) {
      msg.read = true;
      api(`/api/messages/${msg.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ read: true }),
      }).catch(() => {});
      updateBadge();
    }
  }

  // --- Update Extension Badge ---
  function updateBadge() {
    const unread = state.messages.filter((m) => !m.read).length;
    state.unreadCount = unread;
    el.countUnread.textContent = unread;
    if (typeof chrome !== 'undefined' && chrome.action?.setBadgeText) {
      chrome.action.setBadgeText({ text: unread > 0 ? (unread > 99 ? '99+' : String(unread)) : '' });
      chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
    }
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' }).catch(() => {});
    }
  }

  // --- Copy Address Helper ---
  function copyActiveAddress() {
    if (!state.activeAddr) return;
    navigator.clipboard.writeText(state.activeAddr).then(() => {
      el.copyHint.textContent = 'কপি হয়েছে!';
      el.copyBadge.classList.add('copied');
      el.addrBox.classList.add('copied');
      showToast(`✓ ঠিকানা কপি হয়েছে: ${state.activeAddr}`);
      setTimeout(() => {
        el.copyHint.textContent = 'কপি';
        el.copyBadge.classList.remove('copied');
        el.addrBox.classList.remove('copied');
      }, 1600);
    }).catch(() => {
      showToast('ক্লিপবোর্ডে কপি করা যায়নি');
    });
  }

  // --- Fetch Messages from API ---
  async function fetchMessages(showFeedback = false) {
    try {
      const res = await api('/api/messages?limit=60');
      state.messages = res.messages || [];
      renderMailList();
      updateBadge();
      if (showFeedback) showToast('✓ ইনবক্স আপডেট হয়েছে');
    } catch (e) {
      if (showFeedback) showToast('ইনবক্স লোড করতে ব্যর্থ হয়েছে');
    }
  }

  // --- Quick Generate Email ---
  async function quickGenerateAddress() {
    el.btnQuickGen.disabled = true;
    showToast('নতুন ইমেইল তৈরি হচ্ছে…', 1000);
    try {
      const domainChoice = state.prefDomain === -1 ? 'random' : state.domains[state.prefDomain] || 'random';
      const res = await api('/api/addresses', {
        method: 'POST',
        body: JSON.stringify({ domain: domainChoice }),
      });

      const newAddr = res.address.addr;
      state.activeAddr = newAddr;
      state.activeAddrId = res.address.id;
      state.activeAddrObj = res.address;

      const recent = [newAddr, ...(state.recentAddrs || []).filter((x) => x !== newAddr)].slice(0, 8);
      state.recentAddrs = recent;

      await setStorage({
        activeAddr: newAddr,
        activeAddrId: res.address.id,
        recentAddrs: recent,
      });

      renderHeroCard();
      copyActiveAddress();

      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'ADDRESS_CHANGED', addr: newAddr }).catch(() => {});
      }
      await fetchMessages();
    } catch (err) {
      showToast(err.message || 'নতুন ঠিকানা তৈরি ব্যর্থ হয়েছে');
    } finally {
      el.btnQuickGen.disabled = false;
    }
  }

  // --- SSE Realtime Stream Connection ---
  function connectSSE() {
    if (!state.sseToken) return;
    if (state.evtSource) {
      try { state.evtSource.close(); } catch {}
      state.evtSource = null;
    }

    const base = (state.serverUrl || DEFAULT_SERVER).replace(/\/+$/, '');
    const sseUrl = `${base}/api/events?token=${encodeURIComponent(state.sseToken)}`;

    try {
      const es = new EventSource(sseUrl);
      state.evtSource = es;

      es.onopen = () => {
        el.liveDot.className = 'live-dot on';
        el.liveStatus.textContent = 'Live SSE';
      };

      es.addEventListener('mail:sync', () => {
        fetchMessages();
      });

      es.addEventListener('message_new', (e) => {
        try {
          const msg = JSON.parse(e.data);
          handleIncomingMessage(msg);
        } catch {}
      });

      es.addEventListener('addresses:changed', () => {
        // Address changed event
      });

      es.onerror = () => {
        el.liveDot.className = 'live-dot';
        el.liveStatus.textContent = 'Offline (Auto)';
        try { es.close(); } catch {}
        state.evtSource = null;
        setTimeout(connectSSE, 8000);
      };
    } catch (err) {
      el.liveDot.className = 'live-dot';
      el.liveStatus.textContent = 'Offline';
    }
  }

  // --- Handle Incoming New Message ---
  function handleIncomingMessage(msg) {
    if (!msg) return;
    if (!state.messages.some((m) => m.id === msg.id)) {
      state.messages.unshift(msg);
      renderMailList();
      updateBadge();
    }

    playChime();

    if (msg.otp && state.autoCopy) {
      navigator.clipboard.writeText(msg.otp).catch(() => {});
      showToast(`🔑 OTP কোড: ${msg.otp} অটো-কপি হয়েছে!`, 3500);
    } else {
      const sender = msg.service?.name || msg.from || 'Temp Mail';
      showToast(`📩 নতুন মেইল: ${sender}`, 2500);
    }
  }

  // --- Send Test OTP Mail ---
  async function sendTestOtp() {
    showToast('টেস্ট মেইল পাঠানো হচ্ছে…', 1200);
    try {
      const res = await api('/api/testmail', {
        method: 'POST',
        body: JSON.stringify({ addr: state.activeAddr }),
      });
      if (res.ok) {
        showToast(`✓ কোড ${res.code} পাঠানো হয়েছে!`, 2500);
        await fetchMessages();
      }
    } catch {
      showToast('টেস্ট মেইল পাঠানো যায়নি');
    }
  }

  // --- Populate Domain Selector & Picker Drawer ---
  function populateDomains() {
    const list = state.domains || [];

    // Custom select dropdown
    el.custDomainSelect.innerHTML = `
      <option value="random">Auto-Random Domain</option>
      ${list.map((d) => `<option value="${escapeHtml(d)}">@${escapeHtml(d)}</option>`).join('')}
    `;

    // Domain picker drawer
    el.domainList.innerHTML = `
      <div class="domain-item ${state.prefDomain === -1 ? 'active' : ''}" data-domain="random">
        <div>
          <strong>Auto-Random Domain</strong>
          <small>সব ডোমেইন থেকে র‍্যান্ডম নির্বাচন</small>
        </div>
        <span class="badge ${state.prefDomain === -1 ? 'accent' : ''}">${state.prefDomain === -1 ? 'সক্রিয়' : 'বেছে নিন'}</span>
      </div>
      ${list
        .map((d, idx) => {
          const isActive = state.prefDomain === idx || (!state.prefDomain && idx === 0);
          return `
            <div class="domain-item ${isActive ? 'active' : ''}" data-domain="${escapeHtml(d)}" data-idx="${idx}">
              <div>
                <strong>@${escapeHtml(d)}</strong>
                <small>অফিসিয়াল প্রিমিয়াম MX ডোমেইন</small>
              </div>
              <span class="badge ${isActive ? 'ok' : ''}">${isActive ? 'সক্রিয়' : 'বেছে নিন'}</span>
            </div>
          `;
        })
        .join('')}
    `;
  }

  // --- Apply Theme ---
  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    if (el.themeSeg) {
      el.themeSeg.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', b.dataset.theme === theme);
      });
    }
    setStorage({ theme });
  }

  // --- Initialize App ---
  async function init() {
    // 1. Load Local Storage
    const st = await getStorage([
      'clientId',
      'serverUrl',
      'activeAddr',
      'activeAddrId',
      'recentAddrs',
      'autoCopy',
      'notify',
      'sound',
      'prefDomain',
      'theme',
    ]);

    state.clientId = st.clientId || '';
    state.serverUrl = st.serverUrl || DEFAULT_SERVER;
    state.activeAddr = st.activeAddr || '';
    state.activeAddrId = st.activeAddrId || '';
    state.recentAddrs = st.recentAddrs || [];
    state.autoCopy = st.autoCopy !== undefined ? st.autoCopy : true;
    state.notify = st.notify !== undefined ? st.notify : true;
    state.sound = st.sound !== undefined ? st.sound : true;
    state.prefDomain = st.prefDomain !== undefined ? st.prefDomain : -1;
    state.theme = st.theme || 'light';

    // Generate Client ID if missing
    if (!state.clientId) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      state.clientId = 'ext_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      await setStorage({ clientId: state.clientId });
    }

    // Apply Theme & UI State
    applyTheme(state.theme);
    el.clientIdLabel.textContent = state.clientId;
    el.settingServerUrl.value = state.serverUrl;
    el.toggleAutoCopy.classList.toggle('on', state.autoCopy);
    el.toggleAutoCopy.setAttribute('aria-checked', String(state.autoCopy));
    el.toggleNotify.classList.toggle('on', state.notify);
    el.toggleNotify.setAttribute('aria-checked', String(state.notify));
    el.toggleSound.classList.toggle('on', state.sound);
    el.toggleSound.setAttribute('aria-checked', String(state.sound));

    // Instant Zero-Latency Address display if none stored
    if (!state.activeAddr) {
      const rnd = Math.random().toString(36).slice(2, 9);
      state.activeAddr = `user.${rnd}@safix.tech`;
      state.recentAddrs = [state.activeAddr];
      setStorage({ activeAddr: state.activeAddr, recentAddrs: state.recentAddrs }).catch(() => {});
    }
    renderHeroCard();

    // 2. Fetch Bootstrap Data from Server
    try {
      const boot = await api('/api/bootstrap');
      state.domains = boot.domains || state.domains;
      state.prefDomain = boot.prefDomain !== undefined ? boot.prefDomain : state.prefDomain;
      state.sseToken = boot.sseToken || '';

      populateDomains();

      // Check server addresses
      try {
        const addrList = await api('/api/addresses');
        if (addrList.addresses && addrList.addresses.length > 0) {
          state.activeAddrObj = addrList.addresses[0];
          state.activeAddr = addrList.addresses[0].addr;
          state.activeAddrId = addrList.addresses[0].id;
          const recent = [state.activeAddr, ...(state.recentAddrs || []).filter((x) => x !== state.activeAddr)].slice(0, 8);
          state.recentAddrs = recent;
          await setStorage({
            activeAddr: state.activeAddr,
            activeAddrId: state.activeAddrId,
            recentAddrs: state.recentAddrs,
          });
        }
      } catch {}

      renderHeroCard();
      connectSSE();
      await fetchMessages();
    } catch (err) {
      console.warn('Bootstrap fetch failed:', err);
      el.liveDot.className = 'live-dot';
      el.liveStatus.textContent = 'Server Error';
      showToast('সার্ভার কানেকশন এরর: ' + err.message);
    }

    // 3. Setup Fallback Polling (Every 10 seconds while popup is open)
    state.pollTimer = setInterval(() => {
      fetchMessages(false);
    }, 10000);
  }

  // --- Attach Global Event Listeners ---
  function attachListeners() {
    // Copy on Hero Address Box click
    el.addrBox.addEventListener('click', () => {
      copyActiveAddress();
    });

    // Quick Generate New Email
    el.btnQuickGen.addEventListener('click', () => {
      quickGenerateAddress();
    });

    // Header buttons
    el.btnRefresh.addEventListener('click', async () => {
      el.btnRefresh.classList.add('spinning');
      try {
        await fetchMessages(true);
      } finally {
        setTimeout(() => el.btnRefresh.classList.remove('spinning'), 600);
      }
    });

    el.btnTestOtp.addEventListener('click', () => {
      sendTestOtp();
    });

    el.btnEmptyTest.addEventListener('click', () => {
      sendTestOtp();
    });

    // Web App button
    if (el.btnOpenWeb) {
      el.btnOpenWeb.addEventListener('click', () => {
        const url = state.serverUrl || DEFAULT_SERVER;
        if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
          chrome.tabs.create({ url });
        } else {
          window.open(url, '_blank');
        }
      });
    }

    // Recent Chips click
    el.recentChips.addEventListener('click', async (e) => {
      const chip = e.target.closest('[data-addr]');
      if (!chip) return;
      const addr = chip.dataset.addr;
      if (addr && addr !== state.activeAddr) {
        state.activeAddr = addr;
        await setStorage({ activeAddr: addr });
        renderHeroCard();
        copyActiveAddress();
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({ type: 'ADDRESS_CHANGED', addr }).catch(() => {});
        }
        fetchMessages();
      }
    });

    // Search bar
    el.searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      el.searchClear.hidden = !state.searchQuery;
      renderMailList();
    });

    el.searchClear.addEventListener('click', () => {
      el.searchInput.value = '';
      state.searchQuery = '';
      el.searchClear.hidden = true;
      renderMailList();
    });

    // Mark All Read
    el.btnMarkAllRead.addEventListener('click', async () => {
      try {
        await api('/api/messages/readall', { method: 'POST' });
        state.messages.forEach((m) => { m.read = true; });
        renderMailList();
        updateBadge();
        showToast('✓ সব বার্তা পঠিত হিসেবে চিহ্নিত করা হয়েছে');
      } catch {
        showToast('ব্যর্থ হয়েছে');
      }
    });

    // Filter Chips
    el.filterBar.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-filter]');
      if (!chip) return;
      el.filterBar.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
      chip.classList.add('on');
      state.filter = chip.dataset.filter;
      renderMailList();
    });

    // Mail Item Click (Reader drawer or OTP copy)
    el.mailList.addEventListener('click', (e) => {
      const otpPill = e.target.closest('.otp-pill');
      if (otpPill) {
        e.stopPropagation();
        const code = otpPill.dataset.otp;
        if (code) {
          navigator.clipboard.writeText(code).then(() => {
            showToast(`✓ OTP কোড ${code} কপি হয়েছে!`);
          });
        }
        return;
      }

      const row = e.target.closest('.mail-item');
      if (row) {
        const id = row.dataset.id;
        const msg = state.messages.find((m) => m.id === id);
        if (msg) openReader(msg);
      }
    });

    // Reader Back button
    el.btnBackToInbox.addEventListener('click', () => {
      el.readerDrawer.hidden = true;
      state.activeMsg = null;
      renderMailList();
    });

    // Reader Pin button
    el.btnPinMsg.addEventListener('click', async () => {
      if (!state.activeMsg) return;
      const isPinned = !state.activeMsg.pinned;
      state.activeMsg.pinned = isPinned;
      el.btnPinMsg.classList.toggle('active', isPinned);
      try {
        await api(`/api/messages/${state.activeMsg.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ pinned: isPinned }),
        });
        showToast(isPinned ? '📌 পিন করা হয়েছে' : 'আনপিন করা হয়েছে');
      } catch {}
    });

    // Reader Delete button
    el.btnDeleteMsg.addEventListener('click', async () => {
      if (!state.activeMsg) return;
      const targetId = state.activeMsg.id;
      try {
        await api(`/api/messages/${targetId}`, { method: 'DELETE' });
        state.messages = state.messages.filter((m) => m.id !== targetId);
        el.readerDrawer.hidden = true;
        state.activeMsg = null;
        renderMailList();
        updateBadge();
        showToast('✓ বার্তা মুছে ফেলা হয়েছে');
      } catch {
        showToast('মুছতে ব্যর্থ হয়েছে');
      }
    });

    // Custom Address Drawer
    el.btnCustomSheet.addEventListener('click', () => {
      el.customDrawer.hidden = false;
      el.custLocalInput.focus();
    });

    el.btnCloseCustom.addEventListener('click', () => {
      el.customDrawer.hidden = true;
    });

    el.btnRandLocal.addEventListener('click', () => {
      const rnd = Math.random().toString(36).slice(2, 9);
      el.custLocalInput.value = `user.${rnd}`;
    });

    el.custTtlSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      el.custTtlSeg.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      state.selectedTtl = Number(btn.dataset.ttl) || 0;
    });

    el.btnSubmitCustom.addEventListener('click', async () => {
      const name = el.custLocalInput.value.trim().toLowerCase();
      if (!name || name.length < 3) {
        showToast('নাম কমপক্ষে ৩ অক্ষর হতে হবে');
        return;
      }
      const domainVal = el.custDomainSelect.value;
      const label = el.custLabelInput.value.trim();
      const ttl = state.selectedTtl;

      el.btnSubmitCustom.disabled = true;
      try {
        const res = await api('/api/addresses', {
          method: 'POST',
          body: JSON.stringify({
            name,
            domain: domainVal,
            label,
            ttl,
          }),
        });

        const newAddr = res.address.addr;
        state.activeAddr = newAddr;
        state.activeAddrId = res.address.id;
        state.activeAddrObj = res.address;

        const recent = [newAddr, ...(state.recentAddrs || []).filter((x) => x !== newAddr)].slice(0, 8);
        state.recentAddrs = recent;

        await setStorage({
          activeAddr: newAddr,
          activeAddrId: res.address.id,
          recentAddrs: recent,
        });

        renderHeroCard();
        copyActiveAddress();

        el.customDrawer.hidden = true;
        el.custLocalInput.value = '';
        el.custLabelInput.value = '';

        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage({ type: 'ADDRESS_CHANGED', addr: newAddr }).catch(() => {});
        }
        showToast(`✨ কাস্টম মেইল তৈরি হয়েছে: ${newAddr}`);
      } catch (err) {
        showToast(err.message || 'কাস্টম ঠিকানা তৈরি ব্যর্থ হয়েছে');
      } finally {
        el.btnSubmitCustom.disabled = false;
      }
    });

    // Domain Picker Drawer
    el.btnSwitchDomain.addEventListener('click', () => {
      populateDomains();
      el.domainDrawer.hidden = false;
    });

    el.btnCloseDomain.addEventListener('click', () => {
      el.domainDrawer.hidden = true;
    });

    el.domainList.addEventListener('click', async (e) => {
      const item = e.target.closest('.domain-item');
      if (!item) return;
      const domain = item.dataset.domain;
      try {
        const res = await api('/api/domain', {
          method: 'POST',
          body: JSON.stringify({ domain }),
        });
        state.prefDomain = res.prefDomain;
        await setStorage({ prefDomain: res.prefDomain });
        populateDomains();
        el.domainDrawer.hidden = true;
        showToast(`ডোমেইন সেট হয়েছে: ${domain === 'random' ? 'Auto-Random' : '@' + domain}`);
        await quickGenerateAddress();
      } catch {
        showToast('ডোমেইন পরিবর্তন করা যায়নি');
      }
    });

    // QR Code Modal
    el.btnQrSheet.addEventListener('click', () => {
      if (!state.activeAddr) return;
      renderSvgQr(state.activeAddr, el.qrContainer);
      el.qrText.textContent = state.activeAddr;
      el.qrModal.hidden = false;
    });

    el.btnCloseQr.addEventListener('click', () => {
      el.qrModal.hidden = true;
    });

    el.btnCopyFromQr.addEventListener('click', () => {
      copyActiveAddress();
      el.qrModal.hidden = true;
    });

    // Settings Drawer
    el.btnSettings.addEventListener('click', () => {
      el.settingServerUrl.value = state.serverUrl;
      el.settingsDrawer.hidden = false;
    });

    el.btnCloseSettings.addEventListener('click', () => {
      el.settingsDrawer.hidden = true;
    });

    el.toggleAutoCopy.addEventListener('click', () => {
      state.autoCopy = !state.autoCopy;
      el.toggleAutoCopy.classList.toggle('on', state.autoCopy);
      el.toggleAutoCopy.setAttribute('aria-checked', String(state.autoCopy));
      setStorage({ autoCopy: state.autoCopy });
    });

    el.toggleNotify.addEventListener('click', () => {
      state.notify = !state.notify;
      el.toggleNotify.classList.toggle('on', state.notify);
      el.toggleNotify.setAttribute('aria-checked', String(state.notify));
      setStorage({ notify: state.notify });
    });

    el.toggleSound.addEventListener('click', () => {
      state.sound = !state.sound;
      el.toggleSound.classList.toggle('on', state.sound);
      el.toggleSound.setAttribute('aria-checked', String(state.sound));
      setStorage({ sound: state.sound });
      if (state.sound) playChime();
    });

    // Keyboard Accessibility: Escape key closes active modal / drawer
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (el.qrModal && !el.qrModal.hidden) {
          el.qrModal.hidden = true;
        } else if (el.readerDrawer && !el.readerDrawer.hidden) {
          el.readerDrawer.hidden = true;
          state.activeMsg = null;
          renderMailList();
        } else if (el.customDrawer && !el.customDrawer.hidden) {
          el.customDrawer.hidden = true;
        } else if (el.domainDrawer && !el.domainDrawer.hidden) {
          el.domainDrawer.hidden = true;
        } else if (el.settingsDrawer && !el.settingsDrawer.hidden) {
          el.settingsDrawer.hidden = true;
        }
      }
    });

    // Unlock Web Audio API on first user gesture in popup
    window.addEventListener('click', () => {
      try {
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }
      } catch {}
    }, { once: true });

    el.themeSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      applyTheme(btn.dataset.theme);
    });

    el.btnSaveSettings.addEventListener('click', async () => {
      const newUrl = el.settingServerUrl.value.trim().replace(/\/+$/, '');
      if (newUrl) {
        state.serverUrl = newUrl;
        await setStorage({ serverUrl: newUrl });
        showToast('✓ সেটিংস সংরক্ষিত হয়েছে');
        el.settingsDrawer.hidden = true;
        init();
      }
    });

    el.btnClearInbox.addEventListener('click', async () => {
      if (!confirm('ইনবক্সের সব বার্তা মুছে ফেলতে চান?')) return;
      try {
        await api('/api/messages', { method: 'DELETE' });
        state.messages = [];
        renderMailList();
        updateBadge();
        showToast('✓ ইনবক্স খালি করা হয়েছে');
        el.settingsDrawer.hidden = true;
      } catch {
        showToast('মুছতে ব্যর্থ হয়েছে');
      }
    });
  }

  // --- Run on Load ---
  document.addEventListener('DOMContentLoaded', () => {
    attachListeners();
    init();
  });
})();
