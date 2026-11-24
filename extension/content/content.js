/* Ariyan Temp Mail — Content Script (In-Page Autofill & Dropdown)
 * Matches official Temp-Mail.io in-page autofill icon and dropdown
 */

(function () {
  'use strict';

  let activeDropdown = null;
  let activeTriggerBtn = null;
  let lastTargetElement = null;

  // Track focused or right-clicked input elements
  document.addEventListener('contextmenu', (e) => {
    lastTargetElement = e.target;
  }, true);

  document.addEventListener('focusin', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) {
      lastTargetElement = e.target;
    }
  }, true);

  // Floating Toast Notification
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
      background: #0f172a;
      color: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      font-weight: 600;
      padding: 10px 16px;
      border-radius: 12px;
      border: 1px solid rgba(16, 185, 129, 0.5);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25), 0 0 15px rgba(16, 185, 129, 0.2);
      backdrop-filter: blur(12px);
      transition: opacity 0.2s ease, transform 0.2s ease;
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
      setTimeout(() => toast.remove(), 220);
    }, 2400);
  }

  // Check if an input element is likely an email field
  function isEmailInput(input) {
    if (!input || input.type === 'hidden' || input.type === 'password' || input.type === 'submit' || input.type === 'checkbox' || input.type === 'radio') return false;
    if (input.type === 'email') return true;

    const name = (input.name || '').toLowerCase();
    const id = (input.id || '').toLowerCase();
    const placeholder = (input.placeholder || '').toLowerCase();
    const autocomplete = (input.autocomplete || '').toLowerCase();
    const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
    const testId = (input.getAttribute('data-testid') || '').toLowerCase();

    return (
      autocomplete === 'email' ||
      autocomplete === 'username' ||
      name.includes('email') ||
      name.includes('mail') ||
      id.includes('email') ||
      id.includes('mail') ||
      placeholder.includes('email') ||
      placeholder.includes('ইমেইল') ||
      placeholder.includes('mail') ||
      placeholder.includes('enter your') ||
      ariaLabel.includes('email') ||
      ariaLabel.includes('mail') ||
      testId.includes('email')
    );
  }

  // Create or update the small [t] icon button next to or inside the email input
  function attachAutofillIcon(input) {
    if (!input || input.dataset.tmIconAttached === 'true') return;
    input.dataset.tmIconAttached = 'true';

    const btn = document.createElement('div');
    btn.className = '__tm_input_icon_btn__';
    btn.title = 'Ariyan Temp Mail Autofill';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="13" height="13" fill="#ffffff" style="pointer-events:none;">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
      </svg>
    `;
    btn.style.cssText = `
      position: fixed;
      width: 24px;
      height: 24px;
      background: linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 2147483640;
      box-shadow: 0 2px 6px rgba(109, 40, 217, 0.4);
      transition: transform 0.15s ease, background 0.15s ease;
      user-select: none;
      box-sizing: border-box;
    `;

    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.1)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)';
    });

    document.body.appendChild(btn);

    function updatePos() {
      if (!input || !document.contains(input)) {
        btn.remove();
        return;
      }
      const rect = input.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || window.getComputedStyle(input).display === 'none' || window.getComputedStyle(input).visibility === 'hidden') {
        btn.style.display = 'none';
        return;
      }
      btn.style.display = 'flex';
      btn.style.top = `${rect.top + (rect.height - 24) / 2}px`;
      btn.style.left = `${rect.right - 32}px`;
    }

    updatePos();
    window.addEventListener('resize', updatePos, { passive: true });
    window.addEventListener('scroll', updatePos, true);

    // Handle Click on Icon -> Show Dropdown Menu (Image 6)
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (activeDropdown) {
        closeDropdown();
      } else {
        openDropdown(input, btn);
      }
    });
  }

  // Open the Temp-Mail Autofill Dropdown Menu (Image 6 style)
  async function openDropdown(input, triggerBtn) {
    closeDropdown();

    let storageData = {};
    try {
      storageData = await new Promise((res) => {
        chrome.storage.local.get(['activeAddr', 'serverUrl'], (data) => res(data || {}));
      });
    } catch {}

    const currentEmail = storageData.activeAddr || 'লোড হচ্ছে…';
    const serverUrl = storageData.serverUrl || 'https://temp-mail-pks1.onrender.com';

    // Switch icon to [ ✕ ]
    triggerBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="12" height="12" stroke="#ffffff" stroke-width="2.5" fill="none" style="pointer-events:none;">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    `;
    activeTriggerBtn = triggerBtn;

    const dropdown = document.createElement('div');
    dropdown.className = '__tm_autofill_dropdown__';
    dropdown.style.cssText = `
      position: absolute;
      width: 280px;
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 12px 36px rgba(15, 23, 42, 0.22), 0 2px 8px rgba(0, 0, 0, 0.08);
      border: 1px solid #e2e8f0;
      padding: 10px;
      z-index: 2147483646;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 8px;
      animation: __tm_fade_in 0.15s ease-out;
    `;

    // Dropdown HTML layout (Matching Image 6)
    dropdown.innerHTML = `
      <style>
        @keyframes __tm_fade_in {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .__tm_btn_choice__ {
          width: 100%;
          background: #5b21b6;
          color: #ffffff;
          border: none;
          border-radius: 8px;
          padding: 10px 12px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          transition: background 0.15s ease, transform 0.1s ease;
          box-sizing: border-box;
          word-break: break-all;
          text-align: center;
        }
        .__tm_btn_choice__:hover {
          background: #4c1d95;
        }
        .__tm_btn_choice__:active {
          transform: scale(0.98);
        }
        .__tm_btn_dash__ {
          width: 100%;
          background: #f1f5f9;
          color: #334155;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          padding: 8px 12px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          transition: background 0.15s ease;
          box-sizing: border-box;
        }
        .__tm_btn_dash__:hover {
          background: #e2e8f0;
          color: #0f172a;
        }
      </style>
      <button type="button" class="__tm_btn_choice__" id="__tm_btn_fill__" title="এই মেইলটি ইনপুটে বসান">
        ${escapeHtml(currentEmail)}
      </button>
      <button type="button" class="__tm_btn_choice__" id="__tm_btn_gen__" title="নতুন মেইল বানিয়ে বসান">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="#ffffff">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
        Generate a new temp mail
      </button>
      <button type="button" class="__tm_btn_dash__" id="__tm_btn_dash__">
        Dashboard ↗
      </button>
    `;

    document.body.appendChild(dropdown);
    activeDropdown = dropdown;

    // Position dropdown below input
    function positionDropdown() {
      const rect = input.getBoundingClientRect();
      dropdown.style.position = 'fixed';
      const dropdownHeight = 150;
      const spaceBelow = window.innerHeight - rect.bottom;
      if (spaceBelow < dropdownHeight && rect.top > dropdownHeight) {
        dropdown.style.top = `${rect.top - dropdownHeight - 6}px`;
      } else {
        dropdown.style.top = `${rect.bottom + 6}px`;
      }
      dropdown.style.left = `${Math.max(10, Math.min(window.innerWidth - 290, rect.right - 280))}px`;
    }
    positionDropdown();

    // Event 1: Click Current Email -> Fill into input
    const btnFill = dropdown.querySelector('#__tm_btn_fill__');
    if (btnFill) {
      btnFill.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fillInput(input, currentEmail);
        closeDropdown();
      });
    }

    // Event 2: Click Generate New Temp Mail -> Ask background, fill into input
    const btnGen = dropdown.querySelector('#__tm_btn_gen__');
    if (btnGen) {
      btnGen.addEventListener('click', (ev) => {
        ev.stopPropagation();
        btnGen.textContent = 'Generating…';
        btnGen.disabled = true;

        chrome.runtime.sendMessage({ type: 'GENERATE_NEW_ADDR' }, (res) => {
          if (res && res.ok && res.addr) {
            fillInput(input, res.addr);
            showFloatingToast(`✨ New Temp Mail created & inserted: ${res.addr}`);
          } else {
            showFloatingToast('নতুন মেইল তৈরি ব্যর্থ হয়েছে');
          }
          closeDropdown();
        });
      });
    }

    // Event 3: Click Dashboard -> Open Web App
    const btnDash = dropdown.querySelector('#__tm_btn_dash__');
    if (btnDash) {
      btnDash.addEventListener('click', (ev) => {
        ev.stopPropagation();
        chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
        closeDropdown();
      });
    }
  }

  function fillInput(input, email) {
    if (!input || !email) return;
    input.focus();
    if (input.isContentEditable) {
      input.textContent = email;
    } else {
      input.value = email;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    showFloatingToast(`✓ Temp Mail inserted: ${email}`);
  }

  function closeDropdown() {
    if (activeDropdown) {
      activeDropdown.remove();
      activeDropdown = null;
    }
    if (activeTriggerBtn) {
      activeTriggerBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="13" height="13" fill="#ffffff" style="pointer-events:none;">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
      `;
      activeTriggerBtn = null;
    }
  }

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (activeDropdown && !activeDropdown.contains(e.target) && (!activeTriggerBtn || !activeTriggerBtn.contains(e.target))) {
      closeDropdown();
    }
  });

  // Scan page for email inputs and attach icons
  function scanInputs() {
    const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="password"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"])');
    inputs.forEach((inp) => {
      if (isEmailInput(inp)) {
        attachAutofillIcon(inp);
      }
    });
  }

  // Initial Scan & Periodic Fallback for dynamic SPAs
  scanInputs();
  setInterval(scanInputs, 1500);

  // Focus listener to attach icon immediately when user clicks into an email input
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el && el.tagName === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (['text', 'email', 'search', ''].includes(type)) {
        if (isEmailInput(el) || /email|mail/i.test(el.placeholder || el.name || el.id || el.getAttribute('aria-label') || '')) {
          attachAutofillIcon(el);
        }
      }
    }
  }, true);

  // MutationObserver for SPA / dynamic forms
  const observer = new MutationObserver(() => {
    scanInputs();
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

  // Right-click autofill message listener from context menu
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'AUTOFILL_TEMP_MAIL' && msg.addr) {
      const el = (lastTargetElement && document.contains(lastTargetElement))
        ? lastTargetElement
        : document.activeElement;

      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        fillInput(el, msg.addr);
        sendResponse({ ok: true });
      } else {
        navigator.clipboard?.writeText(msg.addr).then(() => {
          showFloatingToast(`✓ Temp Mail copied to clipboard: ${msg.addr}`);
        }).catch(() => {});
        sendResponse({ ok: false, reason: 'no_input_focused' });
      }
    }
  });

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
