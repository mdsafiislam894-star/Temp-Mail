import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = '1:T';
const { mailCard, mailKeyboard, mainLink } = await import('../src/ui.js');

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
