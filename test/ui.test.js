import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = '1:T';
const { mailCard, mailKeyboard, mainLink, genCard, genKeyboard, totpVaultView } = await import('../src/ui.js');

const base = { id: 'a1', to: 'x@d.com', date: Date.now(), service: { icon: '🔵', name: 'Meta' }, purpose: 'Email Verification', links: [] };

test('code only → one green copy button', () => {
  const kb = mailKeyboard({ ...base, otp: '123456' }).inline_keyboard;
  assert.equal(kb[0].length, 1);
  assert.equal(kb[0][0].copy_text.text, '123456');
  assert.equal(kb[0][0].style, 'success');
});
test('link only → one blue link button', () => {
  const kb = mailKeyboard({ ...base, links: [{ url: 'https://a.com/v', label: 'Verify', host: 'a.com', score: 5 }] }).inline_keyboard;
  assert.equal(kb[0].length, 1);
  assert.equal(kb[0][0].style, 'primary');
});
test('code + weak link → link hidden; code + strong link → both', () => {
  const weak = { ...base, otp: '1111', links: [{ url: 'https://a.com/help', label: 'Learn more', host: 'a.com', score: 0 }] };
  assert.equal(mainLink(weak), null);
  const strong = { ...base, otp: '1111', links: [{ url: 'https://a.com/confirm', label: 'Confirm', host: 'a.com', score: 5 }] };
  assert.equal(mailKeyboard(strong).inline_keyboard[0].length, 2);
});
test('no Mini App inline button on mail cards', () => {
  assert.ok(!mailKeyboard({ ...base, otp: '1' }).inline_keyboard.flat().some((b) => b.web_app));
});
test('smart card is two short lines', () => {
  assert.equal(mailCard({ ...base, otp: '1' }, null, 'smart').split('\n').length, 3);
});

test('genCard & genKeyboard show copy_text button and Change Name button (Image 1)', () => {
  const rec = { id: 'a1', addr: 'gojo42@mdsafiislam.tech', label: 'Dev', ttl: 60, expiresAt: Date.now() + 3600000 };
  const text = genCard(rec);
  assert.match(text, /Your Instant Disposable Email/);
  const kb = genKeyboard(rec).inline_keyboard;
  assert.equal(kb[0][0].copy_text.text, 'gojo42@mdsafiislam.tech');
  assert.equal(kb[0][0].style, 'success');
  assert.equal(kb[1][0].callback_data, 'gn');
  assert.equal(kb[1][0].text, '🔄 Change Name');
});

test('totpVaultView renders formatted codes and native copy_text buttons', () => {
  const view = totpVaultView([
    { id: 't1', name: 'GitHub', issuer: 'GitHub', code: '492817', nextCode: '301122', remaining: 19, pinned: true },
  ]);
  assert.match(view.text, /492 817/);
  assert.match(view.text, /GitHub/);
  assert.equal(view.markup.inline_keyboard[0][0].copy_text.text, '492817');
  assert.equal(view.markup.inline_keyboard[0][0].style, 'success');
  assert.ok(view.markup.inline_keyboard[0].some((b) => b.callback_data === 'tf:ed:t1' && b.style === 'primary'));
});

test('inline keyboards use colorful styles and bot mainMenu keeps only 3 buttons', async () => {
  const gk = genKeyboard({ id: 'a9', addr: 'neo9@safix.tech', domain: 'safix.tech', ttl: 0, pinned: false }).inline_keyboard.flat();
  assert.ok(gk.some((b) => b.copy_text?.text === 'neo9@safix.tech' && b.style === 'success'));
  assert.ok(gk.some((b) => b.callback_data === 'gn' && b.style === 'primary'));

  const botSrc = (await import('fs')).readFileSync(new URL('../src/bot.js', import.meta.url), 'utf8');
  const menuBlock = botSrc.match(/const mainMenu = [\s\S]*?\n\};/)?.[0] || '';
  assert.match(menuBlock, /⚡ Instant Mail[\s\S]*🎯 Custom[\s\S]*👑 Admin/);
  assert.doesNotMatch(menuBlock, /2FA Vault|📬 Inbox|Domain|Mail App|Settings/);
});
