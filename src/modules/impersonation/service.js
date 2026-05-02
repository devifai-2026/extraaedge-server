import * as repo from './repo.js';
import { findById as findTenant } from '../tenants/repo.js';
import { getTenantPool } from '../../db/tenant.js';
import { signAccessToken, signRefreshToken } from '../../lib/jwt.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { recordPlatformAudit } from '../../services/platform-audit.js';
import { PLATFORM_ROLES } from '../../config/constants.js';

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
