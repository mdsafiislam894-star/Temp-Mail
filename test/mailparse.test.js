import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOtp, extractLinks, detectService, detectPurpose, analyze, htmlToText } from '../src/lib/mailparse.js';

test('otp: keyword + newline', () => assert.equal(extractOtp('Login Verification', 'Your verification code is:\n\n815468\n'), '815468'));
test('otp: spaced', () => assert.equal(extractOtp('', 'Your code: 123 456'), '123456'));
test('otp: skips year', () => assert.equal(extractOtp('', 'Use code in 2026. Your code is 4821'), '4821'));
test('otp: promo has none', () => assert.equal(extractOtp('Big sale', 'Save 50% until 12/31. Call 5551234 now'), null));
test('otp: standalone line', () => assert.equal(extractOtp('Confirm your email', 'Hi\n020812\nThanks'), '020812'));
test('otp: "is your"', () => assert.equal(extractOtp('', '739201 is your Meta code'), '739201'));
test('service: netflix not X', () => assert.equal(detectService({ from: 'Netflix <info@netflix.com>' }).name, 'Netflix'));
test('service: body "metadata" is not Meta', () => assert.notEqual(detectService({ from: 'a@shop.io', text: 'metadata parametric pineapple' }).name, 'Meta'));
test('service: display-name fallback', () => assert.equal(detectService({ from: 'Acme Bank <x@acme.bank>' }).name, 'Acme Bank'));
test('links: picks verify link first, drops unsubscribe', () => {
  const html = '<a href="https://x.com/unsubscribe?u=1">Unsub</a><a href="https://site.com/home">Home</a><a href="https://site.com/verify?t=1&amp;b=2">Verify email</a>';
  const l = extractLinks(html, '');
  assert.equal(l[0].url, 'https://site.com/verify?t=1&b=2');
  assert.ok(!l.some((x) => /unsubscribe/.test(x.url)));
});
test('purpose', () => {
  assert.equal(detectPurpose('Reset your password', ''), 'Password Reset');
  assert.equal(detectPurpose('Hello', 'sign in attempt'), 'Login Verification');
});
test('html to text', () => assert.equal(htmlToText('<style>a{}</style><p>Hi&nbsp;there</p><p>Code <b>1234</b></p>'), 'Hi there\nCode 1234'));
test('analyze end-to-end', () => {
  const r = analyze({ from: 'no-reply@vsphone.com', subject: 'Login Verification', html: '<p>Your verification code is <b>815468</b></p><a href="https://t.me/+abc">Join</a>' });
  assert.equal(r.otp, '815468');
  assert.equal(r.purpose, 'Login Verification');
});
