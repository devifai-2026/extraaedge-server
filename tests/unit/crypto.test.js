import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, hmac, safeEqual, shortCode } from '../../src/lib/crypto.js';

test('encrypt/decrypt roundtrip', () => {
  const cipher = encrypt('hello world');
  assert.equal(decrypt(cipher), 'hello world');
});

test('hmac + safeEqual', () => {
  const sig = hmac('secret', 'body');
  assert.equal(safeEqual(sig, hmac('secret', 'body')), true);
  assert.equal(safeEqual(sig, 'tampered'), false);
});

test('shortCode length', () => {
  assert.equal(shortCode(8).length, 8);
  assert.match(shortCode(12), /^[A-Z0-9]+$/);
});
