// Rate limiting has been disabled across the product per product decision.
// We keep the same export names so existing route mounts (auth, password reset,
// OTP, the global app limiter) keep working without code changes — they're now
// just no-op middlewares.
//
// To re-enable later, restore the express-rate-limit instances. The original
// implementation lived in git history; the env knobs (RATE_LIMIT_* in env.js)
// are preserved so a future revert is easy.

const noop = (_req, _res, next) => next();

export const globalLimiter = noop;
export const loginLimiter = noop;
export const passwordResetLimiter = noop;
export const otpLimiter = noop;
