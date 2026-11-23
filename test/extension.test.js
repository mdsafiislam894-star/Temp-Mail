import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const POPUP_HTML = path.join(ROOT, 'extension', 'popup', 'popup.html');
const POPUP_CSS = path.join(ROOT, 'extension', 'popup', 'popup.css');
const POPUP_JS = path.join(ROOT, 'extension', 'popup', 'popup.js');
const MANIFEST = path.join(ROOT, 'extension', 'manifest.json');
const EXT_FOLDER = path.join(ROOT, '..', 'Temp-Mail-Extension');
const EXT_ZIP = path.join(ROOT, '..', 'Temp-Mail-Extension.zip');

test('Extension: popup.css strictly enforces [hidden] { display: none !important; }', () => {
  const css = fs.readFileSync(POPUP_CSS, 'utf8');
  assert.match(
    css,
    /\[hidden\][\s\S]*?display:\s*none\s*!important/i,
    'popup.css must enforce display: none !important for [hidden]'
  );
  assert.ok(css.includes('.modal:not([hidden])'), 'popup.css must guard .modal with :not([hidden])');
  assert.ok(css.includes('.drawer:not([hidden])'), 'popup.css must guard .drawer with :not([hidden])');
});

test('Extension: popup.html has hidden attribute on all overlays and modals by default', () => {
  const html = fs.readFileSync(POPUP_HTML, 'utf8');
  assert.match(html, /id="qrModal"[^>]*hidden/, 'qrModal must have hidden attribute');
  assert.match(html, /id="readerDrawer"[^>]*hidden/, 'readerDrawer must have hidden attribute');
  assert.match(html, /id="customDrawer"[^>]*hidden/, 'customDrawer must have hidden attribute');
  assert.match(html, /id="domainDrawer"[^>]*hidden/, 'domainDrawer must have hidden attribute');
  assert.match(html, /id="settingsDrawer"[^>]*hidden/, 'settingsDrawer must have hidden attribute');
  assert.match(html, /id="toast"[^>]*hidden/, 'toast must have hidden attribute');
});

test('Extension: popup.html includes temp-mail.io purple header & action pills', () => {
  const html = fs.readFileSync(POPUP_HTML, 'utf8');
  // Header elements
  assert.ok(html.includes('tempmail'), 'Must include tempmail brand title');
  assert.ok(html.includes('id="liveDot"'), 'Must include liveDot');
  assert.ok(html.includes('id="liveStatus"'), 'Must include liveStatus');
  assert.ok(html.includes('id="btnTestOtp"'), 'Must include btnTestOtp');
  assert.ok(html.includes('id="btnRefresh"'), 'Must include btnRefresh');
  assert.ok(html.includes('id="btnSettings"'), 'Must include btnSettings');

  // Hero Card
  assert.ok(html.includes('id="addrBox"'), 'Must include addrBox');
  assert.ok(html.includes('id="activeAddr"'), 'Must include activeAddr');
  assert.ok(html.includes('id="copyBadge"'), 'Must include copyBadge');
  assert.ok(html.includes('id="btnSwitchDomain"'), 'Must include btnSwitchDomain');

  // 4 Pill Action Buttons
  assert.ok(html.includes('id="btnQuickGen"'), 'Must include btnQuickGen (Random)');
  assert.ok(html.includes('id="btnCustomSheet"'), 'Must include btnCustomSheet (Change)');
  assert.ok(html.includes('id="btnOpenWeb"'), 'Must include btnOpenWeb (Web App)');
  assert.ok(html.includes('id="btnQrSheet"'), 'Must include btnQrSheet (QR Code)');

  // Empty state spinner
  assert.ok(html.includes('class="spinner-container"'), 'Must include spinner container');
  assert.ok(html.includes('class="animated-spinner"'), 'Must include animated spinner');
  assert.ok(html.includes('class="pulse-ring"'), 'Must include pulse ring');
  assert.ok(html.includes('id="btnEmptyTest"'), 'Must include btnEmptyTest');
});

test('Extension: popup.js compiles cleanly and references existing elements', () => {
  const js = fs.readFileSync(POPUP_JS, 'utf8');
  assert.doesNotThrow(() => {
    new Function(js);
  }, 'popup.js must be syntactically valid JS');

  assert.ok(js.includes('btnOpenWeb'), 'popup.js must handle btnOpenWeb');
  assert.ok(js.includes('copyActiveAddress'), 'popup.js must handle copyActiveAddress');
  assert.ok(js.includes('renderSvgQr'), 'popup.js must render QR Code SVG');
});

test('Extension: Temp-Mail-Extension build and ZIP archive exist and contain manifest.json', () => {
  assert.ok(fs.existsSync(EXT_FOLDER), 'Temp-Mail-Extension folder must exist');
  assert.ok(fs.existsSync(path.join(EXT_FOLDER, 'manifest.json')), 'manifest.json must exist in Temp-Mail-Extension');
  assert.ok(fs.existsSync(path.join(EXT_FOLDER, 'popup', 'popup.html')), 'popup.html must exist');
  assert.ok(fs.existsSync(path.join(EXT_FOLDER, 'popup', 'popup.css')), 'popup.css must exist');
  assert.ok(fs.existsSync(path.join(EXT_FOLDER, 'popup', 'popup.js')), 'popup.js must exist');
  assert.ok(fs.existsSync(EXT_ZIP), 'Temp-Mail-Extension.zip must exist');
  const zipStat = fs.statSync(EXT_ZIP);
  assert.ok(zipStat.size > 1000, 'Zip file must have valid size');
});
