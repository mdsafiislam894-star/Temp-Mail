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
const CONTENT_JS = path.join(ROOT, 'extension', 'content', 'content.js');
const BACKGROUND_JS = path.join(ROOT, 'extension', 'background', 'background.js');
const EXT_FOLDER = path.join(ROOT, '..', 'Temp-Mail-Extension');
const EXT_ZIP = path.join(ROOT, '..', 'Temp-Mail-Extension.zip');

test('Extension: popup.css strictly enforces [hidden] { display: none !important; }', () => {
  const css = fs.readFileSync(POPUP_CSS, 'utf8');
  assert.match(
    css,
    /\[hidden\][\s\S]*?display:\s*none\s*!important/i,
    'popup.css must enforce display: none !important for [hidden]'
  );
});

test('Extension: popup.html matches Image 3 & Image 4 with hidden overlays by default', () => {
  const html = fs.readFileSync(POPUP_HTML, 'utf8');
  assert.match(html, /id="qrModal"[^>]*hidden/, 'qrModal must have hidden attribute');
  assert.match(html, /id="readerScreen"[^>]*hidden/, 'readerScreen must have hidden attribute');
  assert.match(html, /id="customDrawer"[^>]*hidden/, 'customDrawer must have hidden attribute');
  assert.match(html, /id="domainDrawer"[^>]*hidden/, 'domainDrawer must have hidden attribute');
  assert.match(html, /id="settingsDrawer"[^>]*hidden/, 'settingsDrawer must have hidden attribute');
  assert.match(html, /id="toast"[^>]*hidden/, 'toast must have hidden attribute');

  // Image 3 elements
  assert.ok(html.includes('মেইল'), 'Must include Bengali title মেইল');
  assert.ok(html.includes('id="btnRandom"'), 'Must include btnRandom (র‍্যান্ডম)');
  assert.ok(html.includes('id="btnChoose"'), 'Must include btnChoose (বাছুন)');
  assert.ok(html.includes('id="btnOpenWeb"'), 'Must include btnOpenWeb');
  assert.ok(html.includes('id="btnQr"'), 'Must include btnQr');
  assert.ok(html.includes('id="btnCopyAddr"'), 'Must include btnCopyAddr');

  // Image 4 elements
  assert.ok(html.includes('আসল মেসেজ'), 'Must include Reader title আসল মেসেজ');
  assert.ok(html.includes('id="readerLinkCard"'), 'Must include readerLinkCard');
  assert.ok(html.includes('id="readerBodyContent"'), 'Must include readerBodyContent');
});

test('Extension: content.js includes in-page autofill icon and dropdown', () => {
  const content = fs.readFileSync(CONTENT_JS, 'utf8');
  assert.ok(content.includes('attachAutofillIcon'), 'content.js must attach autofill icon');
  assert.ok(content.includes('openDropdown'), 'content.js must support dropdown');
  assert.ok(content.includes('Generate a new temp mail'), 'content.js must have generate button');
  assert.ok(content.includes('Dashboard'), 'content.js must have dashboard button');
});

test('Extension: background.js handles GENERATE_NEW_ADDR and notifications', () => {
  const bg = fs.readFileSync(BACKGROUND_JS, 'utf8');
  assert.ok(bg.includes('GENERATE_NEW_ADDR'), 'background.js must handle GENERATE_NEW_ADDR');
  assert.ok(bg.includes('SHOW_DESKTOP_NOTIFICATION'), 'background.js must handle SHOW_DESKTOP_NOTIFICATION');
});

test('Extension: popup.js compiles cleanly and references existing elements', () => {
  const js = fs.readFileSync(POPUP_JS, 'utf8');
  assert.doesNotThrow(() => {
    new Function(js);
  }, 'popup.js must be syntactically valid JS');

  assert.ok(js.includes('openReader'), 'popup.js must handle openReader');
  assert.ok(js.includes('renderSvgQr'), 'popup.js must render QR Code SVG');
});

test('Extension: Temp-Mail-Extension build and ZIP archive exist and contain manifest.json', () => {
  assert.ok(fs.existsSync(EXT_FOLDER), 'Temp-Mail-Extension folder must exist');
  assert.ok(fs.existsSync(path.join(EXT_FOLDER, 'manifest.json')), 'manifest.json must exist in Temp-Mail-Extension');
  assert.ok(fs.existsSync(EXT_ZIP), 'Temp-Mail-Extension.zip must exist');
});
