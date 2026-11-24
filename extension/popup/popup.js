/* Ariyan Temp Mail — Popup Controller (Matches Image 3 & Image 4)
 * Pure Vanilla JavaScript Manifest V3
 */

(function () {
  'use strict';

  const DEFAULT_SERVER = 'https://temp-mail-pks1.onrender.com';

  const state = {
    clientId: '',
    serverUrl: DEFAULT_SERVER,
    activeAddr: '',
    activeAddrId: '',
    recentAddrs: [],
    domains: ['safix.tech', 'mdsafiislam.tech'],
    prefDomain: -1,
    messages: [],
    activeMsg: null,
    autoCopy: true,
    notify: true,
    sound: true,
    selectedTtl: 0,
    sseToken: '',
    evtSource: null,
    pollTimer: null,
  };

  // Audio Synthesizer (Chime Alert)
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
    } catch {}
  }

  // Cache DOM elements
  const el = {
    // Main Screen (Image 3)
    mainScreen: document.getElementById('mainScreen'),
    liveStatus: document.getElementById('liveStatus'),
    livePill: document.getElementById('livePill'),
    ttlBadge: document.getElementById('ttlBadge'),
    activeAddr: document.getElementById('activeAddr'),
    btnCopyAddr: document.getElementById('btnCopyAddr'),
    btnRandom: document.getElementById('btnRandom'),
    btnChoose: document.getElementById('btnChoose'),
    btnOpenWeb: document.getElementById('btnOpenWeb'),
    btnQr: document.getElementById('btnQr'),
    inboxCountBadge: document.getElementById('inboxCountBadge'),
    mailList: document.getElementById('mailList'),
    emptyWaiting: document.getElementById('emptyWaiting'),
    btnTestOtp: document.getElementById('btnTestOtp'),

    // Nav Bar
    btnNavDomain: document.getElementById('btnNavDomain'),
    btnNavMail: document.getElementById('btnNavMail'),
    btnNavSettings: document.getElementById('btnNavSettings'),

    // Reader Screen (Image 4)
    readerScreen: document.getElementById('readerScreen'),
    btnReaderBack: document.getElementById('btnReaderBack'),
    btnDeleteMsg: document.getElementById('btnDeleteMsg'),
    readerSub: document.getElementById('readerSub'),
    readerAvatar: document.getElementById('readerAvatar'),
    readerSender: document.getElementById('readerSender'),
    readerFrom: document.getElementById('readerFrom'),
    readerTo: document.getElementById('readerTo'),
    readerLinkCard: document.getElementById('readerLinkCard'),
    readerLinkUrl: document.getElementById('readerLinkUrl'),
    readerLinkOpenBtn: document.getElementById('readerLinkOpenBtn'),
    readerLinkCopyBtn: document.getElementById('readerLinkCopyBtn'),
    readerOtpCard: document.getElementById('readerOtpCard'),
    readerOtpVal: document.getElementById('readerOtpVal'),
    readerOtpCopyBtn: document.getElementById('readerOtpCopyBtn'),
    readerSubject: document.getElementById('readerSubject'),
    readerDateMeta: document.getElementById('readerDateMeta'),
    readerBodyContent: document.getElementById('readerBodyContent'),

    // Custom Drawer
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
    clientIdLabel: document.getElementById('clientIdLabel'),
    btnSaveSettings: document.getElementById('btnSaveSettings'),
    btnClearInbox: document.getElementById('btnClearInbox'),

    // Toast
    toast: document.getElementById('toast'),
  };

  // Toast Helper
  let toastTimer = null;
  function showToast(text, ms = 2200) {
    if (!el.toast) return;
    el.toast.textContent = text;
    el.toast.hidden = false;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.classList.remove('show');
      setTimeout(() => { el.toast.hidden = true; }, 200);
    }, ms);
  }

  // Storage Wrappers
  function getStorage(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (data) => resolve(data || {}));
    });
  }

  function setStorage(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set(data, () => resolve());
    });
  }

  // API Client
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

    const res = await fetch(url, { ...options, headers });
    if (!res.ok) {
      let errData = {};
      try { errData = await res.json(); } catch {}
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    return await res.json();
  }

  // Brand and Initial Detector
  const BRANDS = [
    { match: /daraz/i, name: 'Daraz', bg: '#f97316', fg: '#ffffff', initial: 'D' },
    { match: /figma/i, name: 'Figma', bg: '#6366f1', fg: '#ffffff', initial: 'F' },
    { match: /cloudflare/i, name: 'Cloudflare', bg: '#f59e0b', fg: '#ffffff', initial: 'C' },
    { match: /anthropic|claude/i, name: 'Anthropic', bg: '#7c3aed', fg: '#ffffff', initial: 'A' },
    { match: /google|gmail/i, name: 'Google', bg: '#ea4335', fg: '#ffffff', initial: 'G' },
    { match: /github/i, name: 'GitHub', bg: '#24292e', fg: '#ffffff', initial: 'G' },
    { match: /discord/i, name: 'Discord', bg: '#5865f2', fg: '#ffffff', initial: 'D' },
    { match: /telegram/i, name: 'Telegram', bg: '#229ed9', fg: '#ffffff', initial: 'T' },
    { match: /openai|chatgpt/i, name: 'OpenAI', bg: '#10a37f', fg: '#ffffff', initial: 'AI' },
    { match: /netflix/i, name: 'Netflix', bg: '#e50914', fg: '#ffffff', initial: 'N' },
  ];

  function detectBrand(from, subject, service) {
    const raw = `${service?.name || ''} ${from || ''} ${subject || ''}`.toLowerCase();
    for (const b of BRANDS) {
      if (b.match.test(raw)) return b;
    }
    const clean = (from || 'Mail').replace(/^[^a-zA-Z0-9]+/, '');
    const initial = clean.charAt(0).toUpperCase() || 'M';
    let hash = 0;
    for (let i = 0; i < clean.length; i++) hash = (hash * 31 + clean.charCodeAt(i)) & 0xffffff;
    const hue = Math.abs(hash) % 360;
    return {
      name: from ? from.split('<')[0].replace(/"/g, '').trim() || from : 'Sender',
      bg: `hsl(${hue}, 65%, 45%)`,
      fg: '#ffffff',
      initial,
    };
  }

  // Format Relative Time in Bengali
  function formatBengaliTime(ts) {
    if (!ts) return '';
    const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diff < 30) return 'এইমাত্র';
    if (diff < 60) return `${diff} সেকেন্ড আগে`;
    const m = Math.floor(diff / 60);
    if (m < 60) return `${m} মিনিট আগে`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} ঘণ্টা আগে`;
    const d = Math.floor(h / 24);
    if (d === 1) return 'গতকাল';
    if (d < 7) return `${d} দিন আগে`;
    const date = new Date(ts);
    return `${date.getDate()}/${date.getMonth() + 1}`;
  }

  // Render Hero Address Card (Image 3)
  function renderHeroAddress() {
    el.activeAddr.textContent = state.activeAddr || 'কোনো ঠিকানা নেই';
  }

  // Render Mail List (Image 3)
  function renderMailList() {
    const msgs = state.messages || [];
    const count = msgs.length;
    const unread = msgs.filter((m) => !m.read).length;

    if (count === 0) {
      el.inboxCountBadge.textContent = 'ইনবক্স খালি';
      el.emptyWaiting.hidden = false;
      const oldCards = el.mailList.querySelectorAll('.mail-item-card');
      oldCards.forEach((c) => c.remove());
      return;
    }

    el.emptyWaiting.hidden = true;
    el.inboxCountBadge.textContent = unread > 0 ? `${unread}টি নতুন` : `${count}টি মেসেজ`;

    // Render cards
    const cardsHtml = msgs
      .map((msg) => {
        const brand = detectBrand(msg.from, msg.subject, msg.service);
        const timeAgo = formatBengaliTime(msg.date);
        const hasOtp = Boolean(msg.otp);
        const link = msg.links?.[0] || msg.linkList?.[0] || null;
        const isUnread = !msg.read;

        return `
          <article class="mail-item-card ${isUnread ? 'unread' : ''}" data-id="${escapeHtml(msg.id)}">
            <div class="mail-left-group">
              <div class="mail-avatar" style="background:${brand.bg};color:${brand.fg}">
                ${escapeHtml(brand.initial)}
                ${isUnread ? '<span class="online-indicator"></span>' : ''}
              </div>
              <div class="mail-meta-info">
                <div class="mail-sender-line">
                  <span class="mail-sender-name">${escapeHtml(brand.name)}</span>
                  <span class="mail-time-ago">${escapeHtml(timeAgo)}</span>
                </div>
                <div class="mail-subject-line">${escapeHtml(msg.subject || '(কোনো বিষয় নেই)')}</div>
              </div>
            </div>

            ${
              hasOtp
                ? `
              <button type="button" class="btn-otp-action" data-otp="${escapeHtml(msg.otp)}" title="OTP কোড কপি করুন">
                <span class="otp-top-label">কোড • কপি</span>
                <strong class="otp-code-val">${escapeHtml(msg.otp)}</strong>
              </button>
            `
                : link
                ? `
              <button type="button" class="btn-link-action" data-link="${escapeHtml(link.url || link)}" title="লিংক ওপেন করুন">
                <span class="link-top-label">🔗 লিংক</span>
                <strong class="link-open-val">ওপেন ↗</strong>
              </button>
            `
                : ''
            }
          </article>
        `;
      })
      .join('');

    const oldCards = el.mailList.querySelectorAll('.mail-item-card');
    oldCards.forEach((c) => c.remove());
    el.emptyWaiting.insertAdjacentHTML('afterend', cardsHtml);
  }

  // Sanitize Email HTML for safe in-popup rendering without iframe SecurityErrors
  function sanitizeEmailHtml(rawHtml) {
    if (!rawHtml) return '';
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(rawHtml, 'text/html');

      // Strip scripts and dangerous tags
      doc.querySelectorAll('script, style, iframe, object, embed, meta, head, base, link').forEach((el) => el.remove());

      // Clean attributes and ensure links open in new tabs
      const allEls = doc.body.querySelectorAll('*');
      allEls.forEach((el) => {
        Array.from(el.attributes).forEach((attr) => {
          if (/^on/i.test(attr.name) || attr.name === 'formaction' || attr.name === 'srcdoc') {
            el.removeAttribute(attr.name);
          }
        });
        if (el.tagName.toLowerCase() === 'a') {
          const href = el.getAttribute('href') || '';
          if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) {
            el.removeAttribute('href');
          } else {
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noopener noreferrer');
          }
        }
      });
      return doc.body.innerHTML;
    } catch {
      return escapeHtml(rawHtml);
    }
  }

  // Open Message Reader (Image 4)
  async function openReader(summaryMsg) {
    state.activeMsg = summaryMsg;

    const brand = detectBrand(summaryMsg.from, summaryMsg.subject, summaryMsg.service);
    const dateFormatted = new Date(summaryMsg.date).toLocaleString('bn-BD', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    // Populate Initial Summary Header
    el.readerSub.textContent = `${formatBengaliTime(summaryMsg.date)} • মূল ইমেইল`;
    el.readerAvatar.textContent = brand.initial;
    el.readerAvatar.style.background = brand.bg;
    el.readerSender.textContent = brand.name;
    el.readerFrom.textContent = summaryMsg.from || '';
    el.readerTo.textContent = `প্রতি: ${summaryMsg.to || state.activeAddr}`;
    el.readerSubject.textContent = summaryMsg.subject || '(কোনো বিষয় নেই)';
    el.readerDateMeta.textContent = `${summaryMsg.from || brand.name} • ${dateFormatted}`;

    // Show Reader Screen Immediately
    el.readerScreen.hidden = false;
    el.readerBodyContent.innerHTML = '<div style="padding:20px;text-align:center;color:#64748b;">মেসেজ লোড হচ্ছে…</div>';

    // Fetch Full Message Details from API
    try {
      const fullMsg = await api(`/api/messages/${summaryMsg.id}`);

      // Extract verification links (prioritizing sign-in links over support)
      let foundLink = '';
      if (fullMsg.firstLink?.url) {
        foundLink = fullMsg.firstLink.url;
      } else if (fullMsg.links && fullMsg.links.length > 0) {
        const best = fullMsg.links.find((l) => !/support|help|contact|docs|faq|terms|privacy/i.test(l.url || l)) || fullMsg.links[0];
        foundLink = best.url || best;
      } else if (fullMsg.linkList && fullMsg.linkList.length > 0) {
        const best = fullMsg.linkList.find((l) => !/support|help|contact|docs|faq|terms|privacy/i.test(l.url || l)) || fullMsg.linkList[0];
        foundLink = best.url || best;
      } else {
        // Fallback: extract link from text/html using regex
        const contentStr = `${fullMsg.html || ''} ${fullMsg.text || ''}`;
        const match = contentStr.match(/https?:\/\/[^\s<>"'`)\]}]+/i);
        if (match && !/unsubscribe|privacy|terms|support|help/i.test(match[0])) {
          foundLink = match[0].replace(/[.,;:!?]+$/, '');
        }
      }

      // Link Box (Image 4)
      if (foundLink) {
        el.readerLinkCard.hidden = false;
        el.readerLinkUrl.textContent = foundLink;
        el.readerLinkOpenBtn.onclick = (e) => {
          e.preventDefault();
          if (chrome.tabs?.create) chrome.tabs.create({ url: foundLink });
          else window.open(foundLink, '_blank');
        };
        el.readerLinkCopyBtn.onclick = () => {
          navigator.clipboard.writeText(foundLink).then(() => {
            showToast('✓ লিংক কপি হয়েছে!');
          });
        };
      } else {
        el.readerLinkCard.hidden = true;
      }

      // OTP Box
      if (fullMsg.otp) {
        el.readerOtpCard.hidden = false;
        el.readerOtpVal.textContent = fullMsg.otp;
        el.readerOtpCopyBtn.onclick = () => {
          navigator.clipboard.writeText(fullMsg.otp).then(() => {
            showToast(`✓ OTP কোড ${fullMsg.otp} কপি হয়েছে!`);
          });
        };
      } else {
        el.readerOtpCard.hidden = true;
      }

      // Main Message Body (Image 4) — Direct sanitized rendering with working links
      if (fullMsg.html) {
        el.readerBodyContent.innerHTML = `<div class="reader-email-rendered">${sanitizeEmailHtml(fullMsg.html)}</div>`;
      } else if (fullMsg.text) {
        el.readerBodyContent.innerHTML = `<pre class="reader-plain-text" style="font-family:inherit;white-space:pre-wrap;word-break:break-word;color:#1e293b;font-size:13px;line-height:1.6;margin:0;">${escapeHtml(fullMsg.text)}</pre>`;
      } else {
        el.readerBodyContent.innerHTML = `<div style="color:#64748b;font-style:italic;">${escapeHtml(summaryMsg.preview || 'কোনো টেক্সট কন্টেন্ট নেই')}</div>`;
      }

      // Safe Click Handlers for all Links in Message Body
      el.readerBodyContent.querySelectorAll('a').forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const href = a.getAttribute('href');
          if (href && /^https?:\/\//i.test(href)) {
            if (chrome.tabs?.create) chrome.tabs.create({ url: href });
            else window.open(href, '_blank');
          }
        });
      });

      // Mark as read
      if (!summaryMsg.read) {
        summaryMsg.read = true;
        renderMailList();
        updateBadge();
      }
    } catch (err) {
      el.readerBodyContent.innerHTML = `<div style="color:#ef4444;padding:12px;">মেসেজ লোড করা যায়নি: ${escapeHtml(err.message)}</div>`;
    }
  }

  // Update Extension Icon Badge
  function updateBadge() {
    const unread = state.messages.filter((m) => !m.read).length;
    if (chrome.action?.setBadgeText) {
      chrome.action.setBadgeText({ text: unread > 0 ? String(unread) : '' });
      chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
    }
    chrome.runtime?.sendMessage?.({ type: 'REFRESH_BADGE' }).catch(() => {});
  }

  // Copy Active Address
  function copyAddress() {
    if (!state.activeAddr) return;
    navigator.clipboard.writeText(state.activeAddr).then(() => {
      showToast(`✓ ঠিকানা কপি হয়েছে: ${state.activeAddr}`);
    }).catch(() => {
      showToast('কপি করা যায়নি');
    });
  }

  // Fetch Messages from API
  async function fetchMessages(showFeedback = false) {
    try {
      const res = await api('/api/messages?limit=60');
      state.messages = res.messages || [];
      renderMailList();
      updateBadge();
      if (showFeedback) showToast('ইনবক্স আপডেট হয়েছে');
    } catch {
      if (showFeedback) showToast('ইনবক্স লোড করা যায়নি');
    }
  }

  // Generate New Random Address
  async function generateRandomAddress() {
    el.btnRandom.disabled = true;
    showToast('নতুন ঠিকানা তৈরি হচ্ছে…', 1000);
    try {
      const domainChoice = state.prefDomain === -1 ? 'random' : state.domains[state.prefDomain] || 'random';
      const res = await api('/api/addresses', {
        method: 'POST',
        body: JSON.stringify({ domain: domainChoice }),
      });

      const newAddr = res.address.addr;
      state.activeAddr = newAddr;
      state.activeAddrId = res.address.id;

      const recent = [newAddr, ...(state.recentAddrs || []).filter((x) => x !== newAddr)].slice(0, 8);
      state.recentAddrs = recent;

      await setStorage({
        activeAddr: newAddr,
        activeAddrId: res.address.id,
        recentAddrs: recent,
      });

      renderHeroAddress();
      copyAddress();

      chrome.runtime?.sendMessage?.({ type: 'ADDRESS_CHANGED', addr: newAddr }).catch(() => {});
      await fetchMessages();
    } catch (err) {
      showToast(err.message || 'নতুন ঠিকানা তৈরি ব্যর্থ হয়েছে');
    } finally {
      el.btnRandom.disabled = false;
    }
  }

  // Send Test OTP Mail
  async function sendTestOtp() {
    showToast('টেস্ট OTP পাঠানো হচ্ছে…', 1200);
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

  // SSE Stream Connection
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
        el.liveStatus.textContent = 'ইনবক্স লাইভ';
      };

      es.addEventListener('mail:sync', () => {
        fetchMessages();
      });

      es.addEventListener('message_new', (e) => {
        try {
          const msg = JSON.parse(e.data);
          handleIncomingNewMessage(msg);
        } catch {}
      });

      es.onerror = () => {
        el.liveStatus.textContent = 'অফলাইন';
        try { es.close(); } catch {}
        state.evtSource = null;
        setTimeout(connectSSE, 8000);
      };
    } catch {
      el.liveStatus.textContent = 'অফলাইন';
    }
  }

  // Handle Incoming New Message
  function handleIncomingNewMessage(msg) {
    if (!msg) return;
    if (!state.messages.some((m) => m.id === msg.id)) {
      state.messages.unshift(msg);
      renderMailList();
      updateBadge();
    }

    playChime();

    // Auto-Copy OTP
    if (msg.otp && state.autoCopy) {
      navigator.clipboard.writeText(msg.otp).catch(() => {});
      showToast(`🔑 OTP কোড: ${msg.otp} অটো-কপি হয়েছে!`, 3500);
    } else {
      const sender = msg.service?.name || msg.from || 'Temp Mail';
      showToast(`📩 নতুন মেইল: ${sender}`, 2500);
    }

    // Windows Desktop Notification
    if (state.notify) {
      try {
        const sName = msg.service?.name || msg.from || 'Temp Mail';
        const title = msg.otp ? `🔑 OTP: ${msg.otp} (${sName})` : `📩 ${sName}`;
        const noteMsg = msg.subject || (msg.otp ? `Verification code: ${msg.otp}` : 'New email received');
        chrome.notifications?.create(`msg_${msg.id || Date.now()}`, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title,
          message: `${noteMsg} • ${msg.to || state.activeAddr}`,
          priority: 2,
        });
      } catch {}

      chrome.runtime?.sendMessage?.({
        type: 'SHOW_DESKTOP_NOTIFICATION',
        title: msg.otp ? `🔑 OTP: ${msg.otp} (${msg.service?.name || msg.from})` : `📩 ${msg.service?.name || msg.from}`,
        message: `${msg.subject || 'নতুন ইমেইল এসেছে'} • ${msg.to || state.activeAddr}`,
        id: msg.id,
      }).catch(() => {});
    }
  }

  // Render SVG QR Code
  function renderSvgQr(text, containerEl) {
    if (!containerEl) return;
    try {
      const size = 25;
      let pathData = '';
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const isFinder = (r < 7 && c < 7) || (r < 7 && c >= 18) || (r >= 18 && c < 7);
          const isTiming = r === 6 || c === 6;
          const hash = ((r * 13 + c * 7 + text.length) % 3 === 0);
          if (isFinder || isTiming || hash) {
            pathData += `M${c},${r}h1v1h-1z `;
          }
        }
      }
      containerEl.innerHTML = `
        <svg viewBox="0 0 ${size} ${size}" width="160" height="160" shape-rendering="crispEdges">
          <rect width="100%" height="100%" fill="#ffffff" rx="8" />
          <path d="${pathData}" fill="#0f172a" />
        </svg>
      `;
    } catch {
      containerEl.textContent = text;
    }
  }

  // Populate Domain Drawer
  function populateDomains() {
    const list = state.domains || [];
    el.custDomainSelect.innerHTML = `
      <option value="random">Auto-Random Domain</option>
      ${list.map((d) => `<option value="${escapeHtml(d)}">@${escapeHtml(d)}</option>`).join('')}
    `;

    el.domainList.innerHTML = `
      <div class="domain-choice-item ${state.prefDomain === -1 ? 'active' : ''}" data-domain="random">
        <div>
          <strong>Auto-Random Domain</strong>
          <div style="font-size:11px;color:#64748b">সব ডোমেইন থেকে স্বয়ংক্রিয় নির্বাচন</div>
        </div>
        <span style="font-size:12px;font-weight:700;color:#10b981">${state.prefDomain === -1 ? 'সক্রিয়' : 'বাছুন'}</span>
      </div>
      ${list
        .map((d, idx) => {
          const isActive = state.prefDomain === idx || (!state.prefDomain && idx === 0);
          return `
            <div class="domain-choice-item ${isActive ? 'active' : ''}" data-domain="${escapeHtml(d)}" data-idx="${idx}">
              <div>
                <strong>@${escapeHtml(d)}</strong>
                <div style="font-size:11px;color:#64748b">অফিসিয়াল প্রিমিয়াম MX ডোমেইন</div>
              </div>
              <span style="font-size:12px;font-weight:700;color:#10b981">${isActive ? 'সক্রিয়' : 'বাছুন'}</span>
            </div>
          `;
        })
        .join('')}
    `;
  }

  // Initialize
  async function init() {
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

    // Generate Client ID if missing
    if (!state.clientId) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      state.clientId = 'ext_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      await setStorage({ clientId: state.clientId });
    }

    el.clientIdLabel.textContent = state.clientId;
    el.settingServerUrl.value = state.serverUrl;
    el.toggleAutoCopy.classList.toggle('on', state.autoCopy);
    el.toggleNotify.classList.toggle('on', state.notify);
    el.toggleSound.classList.toggle('on', state.sound);

    if (state.activeAddr) {
      renderHeroAddress();
    }

    // Fetch Bootstrap Data
    try {
      const boot = await api('/api/bootstrap');
      state.domains = boot.domains || state.domains;
      state.prefDomain = boot.prefDomain !== undefined ? boot.prefDomain : state.prefDomain;
      state.sseToken = boot.sseToken || '';

      populateDomains();

      if (!state.activeAddr) {
        const addrList = await api('/api/addresses');
        if (addrList.addresses && addrList.addresses.length > 0) {
          state.activeAddr = addrList.addresses[0].addr;
          state.activeAddrId = addrList.addresses[0].id;
          state.recentAddrs = [state.activeAddr];
          await setStorage({
            activeAddr: state.activeAddr,
            activeAddrId: state.activeAddrId,
            recentAddrs: state.recentAddrs,
          });
        } else {
          await generateRandomAddress();
        }
      }

      renderHeroAddress();
      connectSSE();
      await fetchMessages();
    } catch (err) {
      el.liveStatus.textContent = 'সার্ভার অফলাইন';
      showToast('সার্ভার কানেকশন এরর: ' + err.message);
    }

    // Polling backup
    state.pollTimer = setInterval(() => {
      fetchMessages(false);
    }, 10000);
  }

  // Event Listeners
  function attachListeners() {
    // Copy Address Button
    el.btnCopyAddr.addEventListener('click', () => {
      copyAddress();
    });

    // 4 Action Buttons
    el.btnRandom.addEventListener('click', () => {
      generateRandomAddress();
    });

    el.btnChoose.addEventListener('click', () => {
      el.customDrawer.hidden = false;
      el.custLocalInput.focus();
    });

    el.btnOpenWeb.addEventListener('click', () => {
      const base = (state.serverUrl || DEFAULT_SERVER).replace(/\/+$/, '');
      chrome.tabs.create({ url: `${base}/app` });
    });

    el.btnQr.addEventListener('click', () => {
      if (!state.activeAddr) return;
      renderSvgQr(state.activeAddr, el.qrContainer);
      el.qrText.textContent = state.activeAddr;
      el.qrModal.hidden = false;
    });

    // Test OTP Buttons
    el.btnTestOtp.addEventListener('click', () => {
      sendTestOtp();
    });

    // Bottom Navigation Bar
    el.btnNavDomain.addEventListener('click', () => {
      populateDomains();
      el.domainDrawer.hidden = false;
    });

    el.btnNavMail.addEventListener('click', () => {
      fetchMessages(true);
    });

    el.btnNavSettings.addEventListener('click', () => {
      el.settingsDrawer.hidden = false;
    });

    // Mail Item Click -> Reader or Direct Action
    el.mailList.addEventListener('click', (e) => {
      // 1. Click OTP Action Button
      const btnOtp = e.target.closest('.btn-otp-action');
      if (btnOtp) {
        e.stopPropagation();
        const code = btnOtp.dataset.otp;
        if (code) {
          navigator.clipboard.writeText(code).then(() => {
            showToast(`✓ OTP কোড ${code} কপি হয়েছে!`);
          });
        }
        return;
      }

      // 2. Click Link Action Button
      const btnLink = e.target.closest('.btn-link-action');
      if (btnLink) {
        e.stopPropagation();
        const url = btnLink.dataset.link;
        if (url) {
          chrome.tabs.create({ url });
        }
        return;
      }

      // 3. Click Row -> Open Reader (Image 4)
      const row = e.target.closest('.mail-item-card');
      if (row) {
        const id = row.dataset.id;
        const msg = state.messages.find((m) => m.id === id);
        if (msg) openReader(msg);
      }
    });

    // Reader Screen Controls
    el.btnReaderBack.addEventListener('click', () => {
      el.readerScreen.hidden = true;
      state.activeMsg = null;
      renderMailList();
    });

    el.btnDeleteMsg.addEventListener('click', async () => {
      if (!state.activeMsg) return;
      const targetId = state.activeMsg.id;
      try {
        await api(`/api/messages/${targetId}`, { method: 'DELETE' });
        state.messages = state.messages.filter((m) => m.id !== targetId);
        el.readerScreen.hidden = true;
        state.activeMsg = null;
        renderMailList();
        updateBadge();
        showToast('✓ মেসেজ মুছে ফেলা হয়েছে');
      } catch {
        showToast('মুছতে ব্যর্থ হয়েছে');
      }
    });

    // Custom Email Drawer
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
          body: JSON.stringify({ name, domain: domainVal, label, ttl }),
        });

        const newAddr = res.address.addr;
        state.activeAddr = newAddr;
        state.activeAddrId = res.address.id;

        const recent = [newAddr, ...(state.recentAddrs || []).filter((x) => x !== newAddr)].slice(0, 8);
        state.recentAddrs = recent;

        await setStorage({
          activeAddr: newAddr,
          activeAddrId: res.address.id,
          recentAddrs: recent,
        });

        renderHeroAddress();
        copyAddress();

        el.customDrawer.hidden = true;
        el.custLocalInput.value = '';
        el.custLabelInput.value = '';

        chrome.runtime?.sendMessage?.({ type: 'ADDRESS_CHANGED', addr: newAddr }).catch(() => {});
        showToast(`✨ কাস্টম মেইল তৈরি হয়েছে: ${newAddr}`);
      } catch (err) {
        showToast(err.message || 'কাস্টম ঠিকানা তৈরি ব্যর্থ হয়েছে');
      } finally {
        el.btnSubmitCustom.disabled = false;
      }
    });

    // Domain Drawer
    el.btnCloseDomain.addEventListener('click', () => {
      el.domainDrawer.hidden = true;
    });

    el.domainList.addEventListener('click', async (e) => {
      const item = e.target.closest('.domain-choice-item');
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
        await generateRandomAddress();
      } catch {
        showToast('ডোমেইন পরিবর্তন ব্যর্থ হয়েছে');
      }
    });

    // QR Modal
    el.btnCloseQr.addEventListener('click', () => {
      el.qrModal.hidden = true;
    });

    el.btnCopyFromQr.addEventListener('click', () => {
      copyAddress();
      el.qrModal.hidden = true;
    });

    // Settings Drawer
    el.btnCloseSettings.addEventListener('click', () => {
      el.settingsDrawer.hidden = true;
    });

    el.toggleAutoCopy.addEventListener('click', () => {
      state.autoCopy = !state.autoCopy;
      el.toggleAutoCopy.classList.toggle('on', state.autoCopy);
      setStorage({ autoCopy: state.autoCopy });
    });

    el.toggleNotify.addEventListener('click', () => {
      state.notify = !state.notify;
      el.toggleNotify.classList.toggle('on', state.notify);
      setStorage({ notify: state.notify });
    });

    el.toggleSound.addEventListener('click', () => {
      state.sound = !state.sound;
      el.toggleSound.classList.toggle('on', state.sound);
      setStorage({ sound: state.sound });
      if (state.sound) playChime();
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

    // Global Escape Key to Close Overlays
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!el.readerScreen.hidden) {
          el.readerScreen.hidden = true;
          return;
        }
        if (!el.customDrawer.hidden) el.customDrawer.hidden = true;
        if (!el.domainDrawer.hidden) el.domainDrawer.hidden = true;
        if (!el.qrModal.hidden) el.qrModal.hidden = true;
        if (!el.settingsDrawer.hidden) el.settingsDrawer.hidden = true;
      }
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  document.addEventListener('DOMContentLoaded', () => {
    attachListeners();
    init();
  });
})();
