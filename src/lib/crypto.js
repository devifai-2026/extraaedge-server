import crypto from 'node:crypto';
import { env } from '../config/env.js';

const KEY = Buffer.from(env.TENANT_SECRET_ENCRYPTION_KEY, 'hex');
const ALGO = 'aes-256-gcm';

// AES-256-GCM envelope encryption for secrets at rest (tenant DB creds, provider keys).
// Output shape: iv(12) || tag(16) || ciphertext  → base64
export const encrypt = (plaintext) => {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
};

export const decrypt = (ciphertextB64) => {
  if (!ciphertextB64) return null;
  const buf = Buffer.from(ciphertextB64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
};

// HMAC-SHA256 helper — used for webhook signing + verification.
export const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

export const safeEqual = (a, b) => {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

export const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// Short URL-safe codes for referrals, magic-links, short tokens.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const shortCode = (length = 8) => {
  const buf = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[buf[i] % ALPHABET.length];
  return out;
};
