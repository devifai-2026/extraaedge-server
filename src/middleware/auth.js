import { verifyToken } from '../lib/jwt.js';
import { unauthenticated } from '../lib/errors.js';

const extractBearer = (req) => {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7);
};

// Accepts any valid access token. Populates req.user with the claim set.
export const authRequired = (req, _res, next) => {
  const token = extractBearer(req);
  if (!token) throw unauthenticated('Missing bearer token');
  try {
    const claims = verifyToken(token);
    req.user = {
      id: claims.sub,
      email: claims.email ?? null,
      tenantId: claims.tenantId ?? null,
      tenantSlug: claims.tenantSlug ?? null,
      role: claims.role ?? null,
      platformRole: claims.platformRole ?? null,
      impersonatedBy: claims.impersonatedBy ?? null,
      trackWork: claims.trackWork ?? false,
      sessionId: claims.sessionId,
      type: claims.type ?? 'access',
      permissions: claims.permissions ?? null,
      allowedTabs: claims.allowedTabs ?? null,
    };
    if (req.user.type !== 'access') throw unauthenticated('Not an access token');
    next();
  } catch (err) {
    next(err);
  }
};

// Variant that allows refresh tokens (used by /auth/refresh only).
export const refreshTokenRequired = (req, _res, next) => {
  const token = extractBearer(req);
  if (!token) throw unauthenticated('Missing refresh token');
  try {
    const claims = verifyToken(token);
    if (claims.type !== 'refresh') throw unauthenticated('Not a refresh token');
    req.refreshClaims = claims;
    next();
  } catch (err) {
    next(err);
  }
};

// Pass-through — attaches req.user if a valid token is present, otherwise continues.
export const authOptional = (req, _res, next) => {
  const token = extractBearer(req);
  if (!token) return next();
  try {
    const claims = verifyToken(token);
    req.user = {
      id: claims.sub,
      email: claims.email ?? null,
      tenantId: claims.tenantId ?? null,
      tenantSlug: claims.tenantSlug ?? null,
      role: claims.role ?? null,
      platformRole: claims.platformRole ?? null,
      sessionId: claims.sessionId,
      trackWork: claims.trackWork ?? false,
      permissions: claims.permissions ?? null,
      allowedTabs: claims.allowedTabs ?? null,
    };
    next();
  } catch {
    next();
  }
};
