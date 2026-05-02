import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { sha256Hex } from './crypto.js';

export const generateOtp = (length = 6) => {
  const digits = '0123456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += digits[bytes[i] % 10];
  return out;
};

export const hashOtp = (otp, phoneOrEmail) => sha256Hex(`${otp}:${phoneOrEmail}`);

export const otpExpiryDate = () => new Date(Date.now() + env.OTP_TTL_MINUTES * 60_000);

export const otpMaxAttempts = () => env.OTP_MAX_ATTEMPTS;
