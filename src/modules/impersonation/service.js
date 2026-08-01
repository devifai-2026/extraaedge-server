import * as repo from './repo.js';
import { findById as findTenant } from '../tenants/repo.js';
import { getTenantPool } from '../../db/tenant.js';
import { signAccessToken, signRefreshToken } from '../../lib/jwt.js';
import { forbidden, notFound, validationError } from '../../lib/errors.js';
import { recordPlatformAudit } from '../../services/platform-audit.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { PLATFORM_ROLES, SYSTEM_TENANT_ROLES } from '../../config/constants.js';

// How long a one-time handoff code stays redeemable. Long enough to survive a
// slow page load, short enough that a URL left in history is dead on arrival.
const HANDOFF_TTL_MS = 2 * 60 * 1000;

// Resolve the target tenant user so we can bake role + allowed tabs into the impersonation JWT.
const loadTenantUser = async (tenant, tenant_user_id) => {
  const pool = await getTenantPool(tenant);
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.role, u.role_id, u.track_work_time,
            r.tab_permissions
       FROM users u
       LEFT JOIN custom_roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.deleted_at IS NULL AND u.is_active = true`,
    [tenant_user_id],
  );
  return rows[0] ?? null;
};

const tabsFromRole = (tab_permissions) => {
  if (!tab_permissions) return null;
  return Object.entries(tab_permissions)
    .filter(([, level]) => level !== 'hidden')
    .map(([k]) => k);
};

export const startImpersonation = async ({ actor, input, ip, user_agent }) => {
  // support_admin is always read_only; only product_owner can flip to writable.
  const readOnly = actor.platformRole === PLATFORM_ROLES.SUPPORT_ADMIN ? true : input.read_only;

  const tenant = await findTenant(input.tenant_id);
  if (!tenant) throw notFound('Tenant not found');
  if (tenant.status !== 'active') throw forbidden('Tenant not active');

  const target = await loadTenantUser(tenant, input.tenant_user_id);
  if (!target) throw notFound('Target tenant user not found or inactive');

  const session = await repo.startSession({
    platform_user_id: actor.id,
    tenant_id: tenant.id,
    tenant_user_id: target.id,
    tenant_user_email: target.email,
    reason: input.reason,
    read_only: readOnly,
    ip,
    user_agent,
  });

  await recordPlatformAudit({
    platform_user_id: actor.id,
    action: 'impersonation.started',
    entity_type: 'tenant_user',
    entity_id: target.id,
    tenant_id: tenant.id,
    after_json: { reason: input.reason, read_only: readOnly },
    ip,
    user_agent,
  });

  const tokenClaims = {
    sub: target.id,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    role: target.role,
    platformRole: actor.platformRole,
    impersonatedBy: actor.id,
    impersonationSessionId: session.id,
    impersonationReadOnly: readOnly,
    trackWork: false, // impersonated activity never counts as tenant user work time
    sessionId: session.id,
    allowedTabs: tabsFromRole(target.tab_permissions),
    type: 'access',
  };

  const accessToken = signAccessToken(tokenClaims);
  const refreshToken = signRefreshToken({ sub: target.id, tenantId: tenant.id, impersonationSessionId: session.id, type: 'refresh' });

  return {
    session,
    access_token: accessToken,
    refresh_token: refreshToken,
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, logo_url: tenant.logo_url, brand_name: tenant.brand_name },
    target_user: { id: target.id, email: target.email, name: target.name, role: target.role },
  };
};

// The tenant's own owner account. Oldest active super_admin wins so the same
// seat is picked every time rather than whichever row sorts first today.
const loadTenantSuperAdmin = async (tenant) => {
  const pool = await getTenantPool(tenant);
  const { rows } = await pool.query(
    `SELECT id, email, name, role
       FROM users
      WHERE role = $1 AND deleted_at IS NULL AND is_active = true
      ORDER BY created_at ASC
      LIMIT 1`,
    [SYSTEM_TENANT_ROLES.SUPER_ADMIN],
  );
  return rows[0] ?? null;
};

/**
 * One-click "log in as this tenant's admin" for the PO console.
 *
 * Resolves the tenant's super_admin, starts a normal (audited) impersonation
 * session, and returns a URL into the admin app carrying a single-use code.
 * The console and the admin app are different origins, so the console cannot
 * write the admin app's session storage itself — the code is the handoff.
 */
export const startTenantAdminImpersonation = async ({ actor, input, ip, user_agent }) => {
  const tenant = await findTenant(input.tenant_id);
  if (!tenant) throw notFound('Tenant not found');
  if (tenant.status !== 'active') throw forbidden('Tenant not active');

  const target = await loadTenantSuperAdmin(tenant);
  if (!target) throw notFound('This tenant has no active super admin to log in as');

  const started = await startImpersonation({
    actor,
    input: {
      tenant_id: tenant.id,
      tenant_user_id: target.id,
      reason: input.reason,
      // A product owner entering the admin console is there to operate it;
      // support_admin is still forced read-only inside startImpersonation.
      read_only: input.read_only ?? false,
    },
    ip,
    user_agent,
  });

  const code = randomToken(32);
  await repo.setHandoff(started.session.id, {
    code_hash: sha256Hex(code),
    expires_at: new Date(Date.now() + HANDOFF_TTL_MS),
  });

  // The console prefers its own configured admin base (APP_WEB_URL is a dev
  // default in plenty of deployments), so hand back the raw code too.
  const base = String(env.APP_WEB_URL || '').replace(/\/+$/, '');
  return {
    handoff_code: code,
    handoff_url: `${base}/sudo?code=${encodeURIComponent(code)}`,
    expires_at: new Date(Date.now() + HANDOFF_TTL_MS),
    tenant: started.tenant,
    target_user: started.target_user,
    session_id: started.session.id,
  };
};

/**
 * Redeem a handoff code for the impersonation token pair. Unauthenticated by
 * necessity — the admin app has no session yet, the code IS the credential.
 * Single-use and short-lived, enforced by the UPDATE in repo.redeemHandoff.
 */
export const exchangeHandoff = async ({ code }) => {
  const session = await repo.redeemHandoff(sha256Hex(code));
  if (!session) throw validationError([{ path: 'code', message: 'This login link is invalid, already used, or expired' }]);

  const tenant = await findTenant(session.tenant_id);
  if (!tenant) throw notFound('Tenant not found');
  if (tenant.status !== 'active') throw forbidden('Tenant not active');

  const target = await loadTenantUser(tenant, session.tenant_user_id);
  if (!target) throw notFound('Target tenant user not found or inactive');

  const tokenClaims = {
    sub: target.id,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    role: target.role,
    platformRole: null,
    impersonatedBy: session.platform_user_id,
    impersonationSessionId: session.id,
    impersonationReadOnly: session.read_only,
    trackWork: false,
    sessionId: session.id,
    allowedTabs: tabsFromRole(target.tab_permissions),
    type: 'access',
  };

  return {
    access_token: signAccessToken(tokenClaims),
    refresh_token: signRefreshToken({ sub: target.id, tenantId: tenant.id, impersonationSessionId: session.id, type: 'refresh' }),
    user: {
      id: target.id, email: target.email, name: target.name, role: target.role,
      impersonated: true,
    },
    tenant: {
      id: tenant.id, slug: tenant.slug, name: tenant.name,
      brand_name: tenant.brand_name, logo_url: tenant.logo_url,
      brand_primary_color: tenant.brand_primary_color,
    },
    allowed_tabs: tabsFromRole(target.tab_permissions),
  };
};

export const stopImpersonation = async ({ session_id, actor, ip, user_agent }) => {
  const ended = await repo.endSession(session_id);
  if (!ended) return null;
  await recordPlatformAudit({
    platform_user_id: actor.id,
    action: 'impersonation.stopped',
    entity_type: 'tenant_user',
    entity_id: ended.tenant_user_id,
    tenant_id: ended.tenant_id,
    ip,
    user_agent,
  });
  return ended;
};

export const listSessions = repo.list;
