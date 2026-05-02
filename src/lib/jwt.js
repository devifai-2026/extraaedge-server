import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { unauthenticated } from './errors.js';

const accessTtlSec = () => env.JWT_ACCESS_TTL_MINUTES * 60;
const refreshTtlSec = () => env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60;

export const signAccessToken = (payload) =>
  jwt.sign(payload, env.JWT_SECRET, {
    algorithm: 'HS256',
    issuer: env.JWT_ISSUER,
    expiresIn: accessTtlSec(),
  });

export const signRefreshToken = (payload) =>
  jwt.sign(payload, env.JWT_SECRET, {
    algorithm: 'HS256',
    issuer: env.JWT_ISSUER,
    expiresIn: refreshTtlSec(),
  });

// Verify against current secret + optional next secret during rotation.
export const verifyToken = (token) => {
  const secrets = [env.JWT_SECRET, env.JWT_SECRET_NEXT].filter(Boolean);
  let lastErr;
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret, { algorithms: ['HS256'], issuer: env.JWT_ISSUER });
    } catch (err) {
      lastErr = err;
    }
  }
  throw unauthenticated(lastErr?.message || 'Invalid token');
};

export const ACCESS_TTL_SECONDS = accessTtlSec;
export const REFRESH_TTL_SECONDS = refreshTtlSec;
