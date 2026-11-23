const DEFAULT_SERVER = 'https://temp-mail-pks1.onrender.com';

function generateClientId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return 'ext_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function getStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get([
      'clientId',
      'serverUrl',
      'activeAddr',
      'activeAddrId',
      'recentAddrs',
      'autoCopy',
      'notify',
      'sound',
      'prefDomain',
      'lastSeenMsgId',
      'unreadCount'
    ], (data) => {
      resolve(data || {});
    });
  });
}

async function setStorage(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

async function initExtension() {
  let { clientId, serverUrl, autoCopy, notify, sound, prefDomain } = await getStorage();
  const updates = {};
  if (!clientId) {
    clientId = generateClientId();
    updates.clientId = clientId;
  }
  if (!serverUrl) updates.serverUrl = DEFAULT_SERVER;
  if (autoCopy === undefined) updates.autoCopy = true;
  if (notify === undefined) updates.notify = true;
  if (sound === undefined) updates.sound = true;
  if (prefDomain === undefined) updates.prefDomain = -1;

  if (Object.keys(updates).length > 0) {
    await setStorage(updates);
  }

  setupContextMenus();
  checkMailSync();
}

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'tm_paste',
      title: '📧 Paste Temp Mail Address',
      contexts: ['editable'],
    });
    chrome.contextMenus.create({
      id: 'tm_copy',
      title: '📋 Copy Temp Mail Address',
      contexts: ['all'],
    });
    chrome.contextMenus.create({
      id: 'tm_new',
      title: '⚡ Generate New Temp Mail',
      contexts: ['all'],
    });
  });
}

async function updateContextMenuTitle(addr) {
  if (!addr) return;
  chrome.contextMenus.update('tm_paste', {
    title: `📧 Paste Temp Mail (${addr})`
  }, () => {
    if (chrome.runtime.lastError) {} // Ignore if menu was refreshed
  });
}

// Background Mail Checker & Notification Dispatcher
async function checkMailSync() {
  const st = await getStorage();
  const server = (st.serverUrl || DEFAULT_SERVER).replace(/\/+$/, '');
  const clientId = st.clientId;
  if (!clientId) return;

  try {
    const res = await fetch(`${server}/api/messages?limit=20`, {
      headers: { 'x-ext-id': clientId },
    });
    if (!res.ok) return;
    const data = await res.json();
    const messages = data.messages || [];
    const unread = data.unread || messages.filter((m) => !m.read).length;

    // Update Extension Badge
    if (unread > 0) {
      chrome.action.setBadgeText({ text: unread > 99 ? '99+' : String(unread) });
      chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
    await setStorage({ unreadCount: unread });

    // Check for fresh incoming messages to notify
    if (messages.length > 0 && st.notify) {
      const newest = messages[0];
      const lastSeen = st.lastSeenMsgId;
      const isNew = newest && newest.id !== lastSeen && (Date.now() - newest.date < 180000);

      if (isNew && !newest.read) {
        await setStorage({ lastSeenMsgId: newest.id });

        const serviceName = newest.service?.name || newest.from || 'Temp Mail';
        const otpCode = newest.otp;

        if (otpCode) {
          if (st.autoCopy) {
            // Write to clipboard if allowed or notify
            notifyUser(
              `🔑 OTP Code: ${otpCode}`,
              `${serviceName} • Click to open email (${newest.to})`,
              newest.id
            );
          } else {
            notifyUser(
              `🔑 OTP Code: ${otpCode}`,
              `${serviceName}: ${newest.subject || 'Verification code received'}`,
              newest.id
            );
          }
        } else {
          notifyUser(
            `📩 ${serviceName}`,
            `${newest.subject || '(No subject)'}`,
            newest.id
          );
        }
      }
    }
  } catch (e) {
    // Silent network catch in background
  }
}

function notifyUser(title, message, id = '') {
  try {
    chrome.notifications.create(id || `msg_${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
      priority: 2,
    });
  } catch (e) {}
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const st = await getStorage();
  const server = (st.serverUrl || DEFAULT_SERVER).replace(/\/+$/, '');
  let activeAddr = st.activeAddr;

  if (info.menuItemId === 'tm_new') {
    try {
      const res = await fetch(`${server}/api/addresses`, {
        method: 'POST',
        headers: { 'x-ext-id': st.clientId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'random' }),
      });
      if (res.ok) {
        const d = await res.json();
        activeAddr = d.address.addr;
        const recent = [d.address.addr, ...(st.recentAddrs || []).filter((x) => x !== d.address.addr)].slice(0, 8);
        await setStorage({ activeAddr, activeAddrId: d.address.id, recentAddrs: recent });
        updateContextMenuTitle(activeAddr);
        notifyUser('✨ New Address Created', activeAddr);
      }
    } catch {}
  }

  if (!activeAddr) {
    // Generate one if none exists
    try {
      const res = await fetch(`${server}/api/addresses`, {
        method: 'POST',
        headers: { 'x-ext-id': st.clientId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'random' }),
      });
      if (res.ok) {
        const d = await res.json();
        activeAddr = d.address.addr;
        await setStorage({ activeAddr, activeAddrId: d.address.id });
        updateContextMenuTitle(activeAddr);
      }
    } catch {}
  }

  if (info.menuItemId === 'tm_paste' || (info.menuItemId === 'tm_new' && info.editable)) {
    if (tab?.id && activeAddr) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'AUTOFILL_TEMP_MAIL',
        addr: activeAddr
      }).catch(() => {
        // Fallback: inject via scripting if content script wasn't loaded
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (addrToFill) => {
            const el = document.activeElement;
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
              el.value = addrToFill;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          },
          args: [activeAddr]
        }).catch(() => {});
      });
    }
  }

  if (info.menuItemId === 'tm_copy') {
    if (activeAddr) {
      notifyUser('✓ Copied to Clipboard', activeAddr);
    }
  }
});

// Periodic background alarm (every 30 seconds)
chrome.alarms.create('checkMailAlarm', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkMailAlarm') {
    checkMailSync();
  }
});

// Runtime messages from popup & content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'REFRESH_BADGE') {
    checkMailSync().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'ADDRESS_CHANGED') {
    if (msg.addr) updateContextMenuTitle(msg.addr);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'GENERATE_NEW_ADDR') {
    (async () => {
      const st = await getStorage();
      const server = (st.serverUrl || DEFAULT_SERVER).replace(/\/+$/, '');
      const res = await fetch(`${server}/api/addresses`, {
        method: 'POST',
        headers: { 'x-ext-id': st.clientId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'random' }),
      });
      if (res.ok) {
        const d = await res.json();
        const activeAddr = d.address.addr;
        const recent = [activeAddr, ...(st.recentAddrs || []).filter((x) => x !== activeAddr)].slice(0, 8);
        await setStorage({ activeAddr, activeAddrId: d.address.id, recentAddrs: recent });
        updateContextMenuTitle(activeAddr);
        notifyUser('✨ New Temp Mail Created', activeAddr);
        sendResponse({ ok: true, addr: activeAddr });
      } else {
        sendResponse({ ok: false, error: 'Failed to create email' });
      }
    })().catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'OPEN_DASHBOARD') {
    (async () => {
      const st = await getStorage();
      const server = (st.serverUrl || DEFAULT_SERVER).replace(/\/+$/, '');
      chrome.tabs.create({ url: `${server}/app` });
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === 'SHOW_DESKTOP_NOTIFICATION') {
    notifyUser(msg.title || '📩 Temp Mail', msg.message || '', msg.id || '');
    sendResponse({ ok: true });
    return true;
  }
});

// Click notification to open popup or extension view
chrome.notifications.onClicked.addListener(() => {
  chrome.action.openPopup?.().catch(() => {});
});

// Initialize on service worker boot
chrome.runtime.onInstalled.addListener(() => initExtension());
chrome.runtime.onStartup.addListener(() => initExtension());
initExtension();
