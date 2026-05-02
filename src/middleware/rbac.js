import { forbidden, unauthenticated } from '../lib/errors.js';

// Usage:
//   router.get('/leads', requireRole('counsellor','sales_manager','super_admin'), ...)
//   router.post('/platform/tenants', requirePlatformRole('product_owner'), ...)
//   router.get('/settings', requireTab('settings.email_templates'), ...)
export const requireRole = (...allowed) => (req, _res, next) => {
  if (!req.user) return next(unauthenticated());
  if (!allowed.includes(req.user.role)) return next(forbidden('Role not permitted'));
  next();
};

export const requirePlatformRole = (...allowed) => (req, _res, next) => {
  if (!req.user) return next(unauthenticated());
  if (!req.user.platformRole || !allowed.includes(req.user.platformRole)) {
    return next(forbidden('Platform role required'));
  }
  next();
};

// Tenant roles assemble via custom-roles table; allowedTabs is precomputed at login and cached in the JWT.
export const requireTab = (tabKey) => (req, _res, next) => {
  if (!req.user) return next(unauthenticated());
  const tabs = req.user.allowedTabs;
  if (!Array.isArray(tabs)) return next(); // null = all tabs (e.g. system super_admin)
  if (!tabs.includes(tabKey)) return next(forbidden(`Tab not permitted: ${tabKey}`));
  next();
};

export const requirePermission = (permissionKey) => (req, _res, next) => {
  if (!req.user) return next(unauthenticated());
  const perms = req.user.permissions;
  if (!perms) return next(); // null permissions = role defaults
  if (perms[permissionKey] === false) return next(forbidden(`Permission denied: ${permissionKey}`));
  next();
};

// "Owner-or-manager" — used on /leads/:id mutations where a counsellor can only touch their own leads.
// Caller passes a loader that returns the resource's assigned_to field.
export const requireOwnershipOrRole = (loadOwnerId, ...managerialRoles) => async (req, _res, next) => {
  try {
    if (!req.user) return next(unauthenticated());
    if (managerialRoles.includes(req.user.role)) return next();
    const ownerId = await loadOwnerId(req);
    if (!ownerId || ownerId !== req.user.id) return next(forbidden('Not the owner'));
    next();
  } catch (err) {
    next(err);
  }
};
