// Shared-secret guard for API → gateway calls. The API sends the same secret
// it expects back on the gateway → API /internal/wa/notify direction.
import { env } from '../config/env.js';
import { safeEqual } from '../lib/crypto.js';

export const internalAuth = (req, res, next) => {
  const got = req.headers['x-internal-secret'];
  if (!got || !safeEqual(String(got), env.WA_GATEWAY_INTERNAL_SECRET)) {
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  }
  return next();
};
