import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { rateLimited } from '../lib/errors.js';

const keyByIpAndTenant = (req) => `${req.ip}:${req.user?.tenantId ?? req.tenant?.id ?? 'public'}`;

export const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.RATE_LIMIT_GLOBAL_PER_MINUTE,
  keyGenerator: keyByIpAndTenant,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(rateLimited(60)),
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.RATE_LIMIT_LOGIN_PER_15MIN,
  keyGenerator: (req) => `${req.ip}:${req.body?.email ?? ''}`,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(rateLimited(15 * 60)),
});

export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: env.RATE_LIMIT_PASSWORD_RESET_PER_HOUR,
  keyGenerator: (req) => `${req.ip}:${req.body?.email ?? ''}`,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(rateLimited(60 * 60)),
});

export const otpLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 5,
  keyGenerator: (req) => `otp:${req.body?.phone ?? req.params?.id ?? req.ip}`,
  handler: (_req, _res, next) => next(rateLimited(60 * 60)),
});
