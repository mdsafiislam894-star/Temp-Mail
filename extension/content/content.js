let lastTargetElement = null;

// Track focused or right-clicked input elements
document.addEventListener('contextmenu', (e) => {
  lastTargetElement = e.target;
}, true);

document.addEventListener('focusin', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
    lastTargetElement = e.target;
  }
}, true);

function showFloatingToast(text) {
  const existing = document.getElementById('__tm_ext_toast__');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = '__tm_ext_toast__';
  toast.textContent = text;
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 2147483647;
    background: rgba(16, 21, 36, 0.94);
    color: #ffffff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 13px;
    font-weight: 600;
    padding: 10px 16px;
    border-radius: 12px;
    border: 1px solid rgba(109, 93, 252, 0.45);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35), 0 0 15px rgba(109, 93, 252, 0.25);
    backdrop-filter: blur(12px);
    transition: opacity 0.25s ease, transform 0.25s ease;
    opacity: 0;
    transform: translateY(-8px);
    pointer-events: none;
  `;

  document.body.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-8px)';
    setTimeout(() => toast.remove(), 250);
  }, 2200);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'AUTOFILL_TEMP_MAIL' && msg.addr) {
    const el = (lastTargetElement && document.contains(lastTargetElement))
      ? lastTargetElement
      : document.activeElement;

    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
      if (el.isContentEditable) {
        el.textContent = msg.addr;
      } else {
        el.value = msg.addr;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      showFloatingToast(`⚡ Temp Mail inserted: ${msg.addr}`);
      sendResponse({ ok: true });
    } else {
      // If no input focused, copy to clipboard and notify
      navigator.clipboard?.writeText(msg.addr).then(() => {
        showFloatingToast(`✓ Temp Mail copied to clipboard: ${msg.addr}`);
      }).catch(() => {});
      sendResponse({ ok: false, reason: 'no_input_focused' });
    }
  }
});
