import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('webapp/qr.js renders valid standalone SVG QR matrices without external requests', async () => {
  const { renderQrSvg, makeQrMatrix } = await import('../webapp/qr.js');
  const mat = makeQrMatrix('gojo42@safix.tech');
  assert.ok(mat.size >= 21 && mat.size <= 57);
  // Top-left 7x7 finder pattern corner and center must be dark modules
  assert.equal(mat.get(0, 0), true);
  assert.equal(mat.get(3, 3), true);
  assert.equal(mat.get(1, 1), false);

  const svg = renderQrSvg('otpauth://totp/GitHub:alice@safix.tech?secret=JBSWY3DPEHPK3PXP&issuer=GitHub');
  assert.match(svg, /^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<path\b/);
  assert.equal(/<(img|image|script|iframe)\b/i.test(svg), false);
  assert.equal(svg.includes('https://'), false);
  // Dark fixed module at (size - 8, 8) and redundant format info parity between Copy 1 & Copy 2
  assert.equal(mat.get(mat.size - 8, 8), true);
  assert.equal(mat.get(8, 0), mat.get(mat.size - 1, 8));
  assert.equal(mat.get(0, 8), mat.get(8, mat.size - 1));
  assert.equal(mat.get(8, 7), mat.get(mat.size - 7, 8));
  assert.equal(mat.get(7, 8), mat.get(8, mat.size - 7));
});

test('webapp/totp.js computes RFC6238 WebCrypto TOTP, parses migration URIs, and detects brands', async () => {
  const totp = await import('../webapp/totp.js');
  // Test vector: secret GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ at t=59s (counter 1) -> 6-digit "287082", 8-digit "94287082"
  const c6 = await totp.computeTotpAsync('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000, { algo: 'SHA1', digits: 6, period: 30 });
  assert.equal(c6.code, '287082');
  assert.equal(c6.remaining, 1);
  assert.equal(totp.formatCode(c6.code), '287 082');

  const c8 = await totp.computeTotpAsync('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000, { algo: 'SHA1', digits: 8, period: 30 });
  assert.equal(c8.code, '94287082');
  assert.equal(totp.formatCode(c8.code), '9428 7082');

  const parsed = totp.parseBulkInput('GitHub Work|JBSWY3DPEHPK3PXP\notpauth://totp/OpenAI:u@x.io?secret=KRSXG5CTMVRXEZLU&issuer=OpenAI');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].issuer, 'GitHub');
  assert.equal(parsed[0].category, 'Dev');
  assert.equal(parsed[1].issuer, 'OpenAI');
  assert.equal(parsed[1].category, 'AI');
});

test('webapp assets are modular, v17.js removed, and Telegram Mini App gate is enforced', () => {
  const webDir = new URL('../webapp/', import.meta.url);
  assert.equal(fs.existsSync(new URL('v17.js', webDir)), false);
  const html = fs.readFileSync(new URL('index.html', webDir), 'utf8');
  assert.equal(html.includes('v17.js'), false);
  assert.match(html, /id="tgGate"/);
  assert.match(html, /id="auroraBg"/);
  assert.match(html, /id="navPill"/);
  assert.match(html, /href="\/app\/styles\.css/);
  assert.match(html, /src="\/app\/app\.js/);
  assert.ok(fs.existsSync(new URL('styles.css', webDir)));
  assert.ok(fs.existsSync(new URL('app.js', webDir)));

  const css = fs.readFileSync(new URL('styles.css', webDir), 'utf8');
  assert.match(css, /\[data-skin="glass"\]/);
  assert.match(css, /\[data-skin="claude"\]/);
  assert.match(css, /\[data-skin="mix"\]/);
  assert.match(css, /\[data-skin="bento"\]/);
  assert.match(css, /\[data-theme="claude"\]/);
  assert.match(css, /\[data-theme="claude-light"\]/);

  const themeDecls = [...css.matchAll(/^\[data-theme="([^"]+)"\]\s*\{/gm)].map((m) => m[1]);
  assert.deepEqual(themeDecls, ['aurora', 'claude', 'daylight', 'claude-light']);
  assert.match(css, /\.theme-card\b/);
  assert.match(css, /\.ic-pill\b/);
  assert.match(css, /\.view\.view-enter\b/);

  const idxHtml = fs.readFileSync(new URL('index.html', webDir), 'utf8');
  for (const sym of ['i-clock', 'i-tag', 'i-bell-off', 'i-mail-open', 'i-moon', 'i-sun', 'i-note', 'i-send']) {
    assert.ok(idxHtml.includes(`id="${sym}"`), `missing symbol ${sym}`);
  }
  const symbolIds = [...idxHtml.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(symbolIds.length, new Set(symbolIds).size, 'duplicate SVG symbol IDs');

  const appJs = fs.readFileSync(new URL('app.js', webDir), 'utf8');
  assert.doesNotMatch(appJs, /\b(prompt|confirm)\(/);
  assert.match(appJs, /openEditAddrSheet/);
  assert.match(appJs, /syncKeyedList/);
});
