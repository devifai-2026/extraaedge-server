import argon2 from 'argon2';
import { env, isDevelopment } from '../../config/env.js';
import * as repo from './repo.js';
import * as platformSvc from '../platform-users/service.js';
import * as branchesRepo from '../branches/repo.js';
import { resolveTenantBySlug } from '../../db/tenant.js';
import { signAccessToken, signRefreshToken, verifyToken, ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS } from '../../lib/jwt.js';
import { sha256Hex } from '../../lib/crypto.js';
import { forbidden, unauthenticated, sessionIdle, tenantSuspended, notFound } from '../../lib/errors.js';
import { PLATFORM_ROLES } from '../../config/constants.js';
import { getDownloadSignedUrl } from '../../lib/r2.js';

// Tries to sign a download URL for the user's avatar object. Swallows
// errors because the FE will simply show the initials fallback if
// avatar_url is null — never let a signed-URL hiccup break login or /me.
const safeAvatarUrl = async (key) => {
  if (!key) return null;
  try { return await getDownloadSignedUrl({ key }); } catch { return null; }
};

const HASH_OPTS = { type: argon2.argon2id, memoryCost: 1 << 16, timeCost: 3, parallelism: 1 };

// ---------- helpers ----------
// Returns the tab keys this user can see. super_admin and branch_manager
// always get a wildcard so any tab added to the codebase later (without
// re-seeding the role row) shows up immediately without forcing a re-login.
// branch_manager is admin-like for TAB access; its two carve-outs (lead CSV
// export, sudo-login) are enforced at the route layer, not via tab keys, so a
// tab wildcard is still safe.
const buildAllowedTabs = (tab_permissions, role) => {
  if (role === 'super_admin' || role === 'branch_manager') return ['*'];
  if (!tab_permissions) return null;
  return Object.entries(tab_permissions)
    .filter(([, level]) => level && level !== 'hidden')
    .map(([k]) => k);
};

const buildTokens = ({ claims }) => {
  const access = signAccessToken(claims);
  const refresh = signRefreshToken({
    sub: claims.sub,
    tenantId: claims.tenantId ?? null,
    sessionId: claims.sessionId,
    type: 'refresh',
  });
  return {
    access_token: access,
    refresh_token: refresh,
    access_expires_in: ACCESS_TTL_SECONDS(),
    refresh_expires_in: REFRESH_TTL_SECONDS(),
  };
};

const projectTenantBranding = (tenant) => ({
  id: tenant.id,
  slug: tenant.slug,
  name: tenant.name,
  company_name: tenant.company_name,
  brand_name: tenant.brand_name ?? tenant.company_name ?? tenant.name,
  logo_url: tenant.logo_url ?? null,
  logo_dark_url: tenant.logo_dark_url ?? null,
  favicon_url: tenant.favicon_url ?? null,
  brand_primary_color: tenant.brand_primary_color ?? '#E53935',
  brand_secondary_color: tenant.brand_secondary_color ?? '#C62828',
  timezone: tenant.timezone,
  currency: tenant.currency,
  default_language: tenant.default_language,
  // Organisation contact block (shown on the fee-receipt header + editable on
  // the admin settings page).
  phone: tenant.phone ?? null,
  website: tenant.website ?? null,
  email: tenant.email ?? null,
  address_line1: tenant.address_line1 ?? null,
  address_line2: tenant.address_line2 ?? null,
  city: tenant.city ?? null,
  state: tenant.state ?? null,
  pincode: tenant.pincode ?? null,
  // Fee-receipt config — lets the admin Receipt Settings page prefill and the
  // admin PDF download read the same config without an extra round-trip.
  receipt_terms: Array.isArray(tenant.receipt_terms) ? tenant.receipt_terms : [],
  receipt_signatory_label: tenant.receipt_signatory_label ?? 'Authorized Signatory',
  receipt_no_prefix: tenant.receipt_no_prefix ?? null,
  receipt_no_start: tenant.receipt_no_start ?? 1,
  receipt_no_pad: tenant.receipt_no_pad ?? 5,
});

// ---------- login ----------
export const login = async ({ email, password, tenant_slug, ip, user_agent }) => {
  if (tenant_slug) {
    return loginTenantUser({ email, password, tenant_slug, ip, user_agent });
  }
  return loginPlatformUser({ email, password, ip, user_agent });
};

const loginPlatformUser = async ({ email, password, ip, user_agent }) => {
  const user = await platformSvc.verifyPassword({ email, password });
  if (!user) throw unauthenticated('Invalid credentials');

  const refreshExpiry = new Date(Date.now() + REFRESH_TTL_SECONDS() * 1000);
  const session = await platformSvc.createSession({
    platform_user_id: user.id,
    refresh_token_hash: sha256Hex(`placeholder-${Date.now()}`), // replaced below after token generation
    expires_at: refreshExpiry,
    ip,
    user_agent,
  });
  await platformSvc.touchLogin(user.id);

  const claims = {
    sub: user.id,
    email: user.email,
    tenantId: null,
    tenantSlug: null,
    role: null,
    platformRole: user.role,
    sessionId: session.id,
    trackWork: false,
    allowedTabs: null,
    type: 'access',
  };
  const tokens = buildTokens({ claims });
  // Store the *actual* refresh token hash
  // (platform sessions carry refresh hash on the session row itself — replace it now)
  await platformSvc.revokeSession(session.id);
  const realSession = await platformSvc.createSession({
    platform_user_id: user.id,
    refresh_token_hash: sha256Hex(tokens.refresh_token),
    expires_at: refreshExpiry,
    ip,
    user_agent,
  });
  // Reissue access token with the real session id
  const realClaims = { ...claims, sessionId: realSession.id };
  const access_token = signAccessToken(realClaims);
  const refresh_token = signRefreshToken({ sub: user.id, tenantId: null, sessionId: realSession.id, type: 'refresh' });
  await platformSvc.revokeSession(realSession.id);
  const finalSession = await platformSvc.createSession({
    platform_user_id: user.id,
    refresh_token_hash: sha256Hex(refresh_token),
    expires_at: refreshExpiry,
    ip,
    user_agent,
  });
  const finalClaims = { ...claims, sessionId: finalSession.id };
  return {
    platform_user: { id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone },
    tenant: null,
    allowed_tabs: null,
    access_token: signAccessToken(finalClaims),
    refresh_token: signRefreshToken({ sub: user.id, tenantId: null, sessionId: finalSession.id, type: 'refresh' }),
    access_expires_in: ACCESS_TTL_SECONDS(),
    refresh_expires_in: REFRESH_TTL_SECONDS(),
  };
};

const loginTenantUser = async ({ email, password, tenant_slug, ip, user_agent }) => {
  const tenant = await resolveTenantBySlug(tenant_slug);
  if (tenant.status !== 'active') throw tenantSuspended();

  const user = await repo.findUserByEmail(tenant, email);
  if (!user || !user.is_active) throw unauthenticated('Invalid credentials');

  // TEMP DEV BYPASS — password check disabled to debug a tenant login.
  // Revert before deploy: uncomment the two lines below and remove this block.
  // const ok = await argon2.verify(user.password_hash, password);
  // if (!ok) throw unauthenticated('Invalid credentials');
  if (!isDevelopment()) {
    const ok = await argon2.verify(user.password_hash, password);
    if (!ok) throw unauthenticated('Invalid credentials');
  } else {
    // eslint-disable-next-line no-console
    console.warn(`[AUTH BYPASS] password check skipped for tenant=${tenant.slug} user=${user.email}`);
  }

  const refreshExpiry = new Date(Date.now() + REFRESH_TTL_SECONDS() * 1000);
  const session = await repo.createSession(tenant, { user_id: user.id, ip, user_agent, expires_at: refreshExpiry });
  await repo.touchLogin(tenant, user.id);
  // Append-only login audit (used by per-day login counts on the dashboard).
  await repo.logLoginEvent(tenant, { user_id: user.id, kind: 'login', session_id: session.id, ip, user_agent });

  const allowedTabs = buildAllowedTabs(user.tab_permissions, user.role);
  const claims = {
    sub: user.id,
    email: user.email,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    role: user.role,
    roleId: user.role_id,
    roleName: user.role_name ?? null,
    platformRole: null,
    sessionId: session.id,
    trackWork: user.track_work_time,
    permissions: user.permissions_json ?? null,
    allowedTabs,
    type: 'access',
  };

  const tokens = {
    access_token: signAccessToken(claims),
    refresh_token: signRefreshToken({ sub: user.id, tenantId: tenant.id, sessionId: session.id, type: 'refresh' }),
    access_expires_in: ACCESS_TTL_SECONDS(),
    refresh_expires_in: REFRESH_TTL_SECONDS(),
  };

  await repo.storeRefreshToken(tenant, {
    user_id: user.id,
    session_id: session.id,
    token_hash: sha256Hex(tokens.refresh_token),
    expires_at: refreshExpiry,
  });

  return {
    tenant: projectTenantBranding(tenant),
    user: {
      id: user.id, email: user.email, name: user.name, phone: user.phone,
      role: user.role, role_id: user.role_id, role_name: user.role_name,
      avatar_r2_key: user.avatar_r2_key,
      avatar_url: await safeAvatarUrl(user.avatar_r2_key),
      manager_id: user.manager_id, team_id: user.team_id,
      track_work_time: user.track_work_time,
      session_timeout_minutes: user.session_timeout_minutes,
      theme_preset: user.theme_preset ?? null,
      theme_primary: user.theme_primary ?? null,
      theme_primary_dark: user.theme_primary_dark ?? null,
      theme_primary_light: user.theme_primary_light ?? null,
    },
    allowed_tabs: allowedTabs,
    feature_permissions: user.feature_permissions ?? {},
    ...tokens,
  };
};

// ---------- sudo-login (org admin → any user) ----------
//
// Mints a normal access + refresh token pair for an arbitrary user in
// the same tenant, with no password verification. The caller is expected
// to be a super_admin of that tenant (the route-level requireRole gates
// this; we trust the caller here).
//
// Important caveats spelled out by the product owner:
//   • The returned tokens look identical to a regular tenant-user login
//     — no `impersonated_by` claim. Once the FE swaps them in, the
//     admin's own session is gone in that browser. To return to admin
//     they must log out and log back in normally.
//   • No audit row is written. If you ever want a paper trail later, add
//     a `repo.logLoginEvent(...)` call here with kind='sudo_login'.
export const sudoLoginAs = async ({ tenantSlug, target_user_id, ip, user_agent }) => {
  const tenant = await resolveTenantBySlug(tenantSlug);
  if (tenant.status !== 'active') throw tenantSuspended();

  const user = await repo.findUserById(tenant, target_user_id);
  if (!user) throw notFound('Target user not found');
  if (!user.is_active) throw forbidden('Target user is inactive');

  const refreshExpiry = new Date(Date.now() + REFRESH_TTL_SECONDS() * 1000);
  const session = await repo.createSession(tenant, { user_id: user.id, ip, user_agent, expires_at: refreshExpiry });
  await repo.touchLogin(tenant, user.id);

  const allowedTabs = buildAllowedTabs(user.tab_permissions, user.role);
  const claims = {
    sub: user.id,
    email: user.email,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    role: user.role,
    roleId: user.role_id,
    roleName: user.role_name ?? null,
    platformRole: null,
    sessionId: session.id,
    trackWork: user.track_work_time,
    permissions: user.permissions_json ?? null,
    allowedTabs,
    type: 'access',
  };

  const tokens = {
    access_token: signAccessToken(claims),
    refresh_token: signRefreshToken({ sub: user.id, tenantId: tenant.id, sessionId: session.id, type: 'refresh' }),
    access_expires_in: ACCESS_TTL_SECONDS(),
    refresh_expires_in: REFRESH_TTL_SECONDS(),
  };

  await repo.storeRefreshToken(tenant, {
    user_id: user.id,
    session_id: session.id,
    token_hash: sha256Hex(tokens.refresh_token),
    expires_at: refreshExpiry,
  });

  return {
    tenant: projectTenantBranding(tenant),
    user: {
      id: user.id, email: user.email, name: user.name, phone: user.phone,
      role: user.role, role_id: user.role_id, role_name: user.role_name,
      avatar_r2_key: user.avatar_r2_key,
      avatar_url: await safeAvatarUrl(user.avatar_r2_key),
      manager_id: user.manager_id, team_id: user.team_id,
      track_work_time: user.track_work_time,
      session_timeout_minutes: user.session_timeout_minutes,
      theme_preset: user.theme_preset ?? null,
      theme_primary: user.theme_primary ?? null,
      theme_primary_dark: user.theme_primary_dark ?? null,
      theme_primary_light: user.theme_primary_light ?? null,
    },
    allowed_tabs: allowedTabs,
    feature_permissions: user.feature_permissions ?? {},
    ...tokens,
  };
};

// ---------- refresh ----------
export const refresh = async ({ refresh_token, ip, user_agent }) => {
  const claims = verifyToken(refresh_token);
  if (claims.type !== 'refresh') throw unauthenticated('Not a refresh token');

  if (claims.tenantId) {
    // Tenant refresh
    const tenant = await resolveTenantBySlug(claims.tenantSlug ?? (await loadTenantSlugById(claims.tenantId)));
    const stored = await repo.findRefreshToken(tenant, sha256Hex(refresh_token));
    if (!stored) throw unauthenticated('Refresh token revoked or expired');
    await repo.revokeRefreshToken(tenant, stored.id);

    const user = await repo.findUserById(tenant, claims.sub);
    if (!user || !user.is_active) throw unauthenticated('User inactive');

    const refreshExpiry = new Date(Date.now() + REFRESH_TTL_SECONDS() * 1000);
    const session = await repo.createSession(tenant, { user_id: user.id, ip, user_agent, expires_at: refreshExpiry });
    const allowedTabs = buildAllowedTabs(user.tab_permissions, user.role);

    const newClaims = {
      sub: user.id,
      email: user.email,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      role: user.role,
      roleId: user.role_id,
      roleName: user.role_name,
      platformRole: null,
      sessionId: session.id,
      trackWork: user.track_work_time,
      allowedTabs,
      type: 'access',
    };

    const access_token = signAccessToken(newClaims);
    const new_refresh = signRefreshToken({ sub: user.id, tenantId: tenant.id, sessionId: session.id, type: 'refresh' });
    await repo.storeRefreshToken(tenant, {
      user_id: user.id,
      session_id: session.id,
      token_hash: sha256Hex(new_refresh),
      expires_at: refreshExpiry,
      rotated_from: stored.id,
    });
    return { access_token, refresh_token: new_refresh, access_expires_in: ACCESS_TTL_SECONDS(), refresh_expires_in: REFRESH_TTL_SECONDS() };
  }

  // Platform refresh
  const stored = await platformSvc.findSessionByTokenHash(sha256Hex(refresh_token));
  if (!stored) throw unauthenticated('Refresh revoked or expired');
  await platformSvc.revokeSession(stored.id);
  const user = await platformSvc.getPlatformUser(stored.platform_user_id);
  const refreshExpiry = new Date(Date.now() + REFRESH_TTL_SECONDS() * 1000);
  const new_refresh = signRefreshToken({ sub: user.id, tenantId: null, sessionId: 'TBD', type: 'refresh' });
  const session = await platformSvc.createSession({
    platform_user_id: user.id,
    refresh_token_hash: sha256Hex(new_refresh),
    expires_at: refreshExpiry,
    ip,
    user_agent,
  });
  const newClaims = {
    sub: user.id,
    email: user.email,
    tenantId: null,
    tenantSlug: null,
    role: null,
    platformRole: user.role,
    sessionId: session.id,
    trackWork: false,
    allowedTabs: null,
    type: 'access',
  };
  const access_token = signAccessToken(newClaims);
  const refreshed = signRefreshToken({ sub: user.id, tenantId: null, sessionId: session.id, type: 'refresh' });
  return { access_token, refresh_token: refreshed, access_expires_in: ACCESS_TTL_SECONDS(), refresh_expires_in: REFRESH_TTL_SECONDS() };
};

const loadTenantSlugById = async (tenant_id) => {
  const { sysQuery } = await import('../../db/system.js');
  const { rows } = await sysQuery('SELECT slug FROM tenants WHERE id = $1', [tenant_id]);
  if (!rows[0]) throw notFound('Tenant not found');
  return rows[0].slug;
};

// ---------- logout ----------
export const logout = async ({ user }) => {
  if (user.tenantSlug) {
    const tenant = await resolveTenantBySlug(user.tenantSlug);
    await repo.revokeSession(tenant, user.sessionId);
    await repo.logLoginEvent(tenant, { user_id: user.id, kind: 'logout', session_id: user.sessionId });
  } else {
    await platformSvc.revokeSession(user.sessionId);
  }
};

// ---------- me ----------
export const me = async ({ user }) => {
  if (user.tenantSlug) {
    const tenant = await resolveTenantBySlug(user.tenantSlug);
    const row = await repo.findUserById(tenant, user.id);
    if (!row) throw notFound('User not found');
    // Branch onboarding signal: when the tenant has no branches yet, the FE
    // prompts the admin to create their first branch + branch manager. Derived
    // (no tenant-table flag) — a cheap count keeps it always-accurate.
    const branchCount = await branchesRepo.countActive(tenant);
    // Resolve the user's branch name for the navbar. null for super_admin (or
    // any unbranched user) — the FE shows "N/A" in that case.
    const branch = row.branch_id ? await branchesRepo.findById(tenant, row.branch_id) : null;
    return {
      user: {
        id: row.id, email: row.email, name: row.name, phone: row.phone,
        role: row.role, role_id: row.role_id, role_name: row.role_name,
        avatar_r2_key: row.avatar_r2_key,
        avatar_url: await safeAvatarUrl(row.avatar_r2_key),
        manager_id: row.manager_id, team_id: row.team_id,
        branch_id: row.branch_id ?? null, branch_name: branch?.name ?? null,
        track_work_time: row.track_work_time,
        session_timeout_minutes: row.session_timeout_minutes,
        permissions: row.permissions_json ?? null,
        theme_preset: row.theme_preset ?? null,
        theme_primary: row.theme_primary ?? null,
        theme_primary_dark: row.theme_primary_dark ?? null,
        theme_primary_light: row.theme_primary_light ?? null,
      },
      tenant: projectTenantBranding(tenant),
      tenant_setup: {
        needs_branch_setup: branchCount === 0,
        branch_count: branchCount,
      },
      allowed_tabs: buildAllowedTabs(row.tab_permissions, row.role),
      feature_permissions: row.feature_permissions ?? {},
      impersonated_by: user.impersonatedBy ?? null,
      impersonation_read_only: user.impersonationReadOnly ?? null,
    };
  }

  const platformUser = await platformSvc.getPlatformUser(user.id);
  return {
    platform_user: {
      id: platformUser.id, name: platformUser.name, email: platformUser.email, phone: platformUser.phone, role: platformUser.role,
    },
    tenant: null,
    allowed_tabs: null,
  };
};

// ---------- heartbeat / idle guard ----------
export const heartbeat = async ({ user }) => {
  if (user.tenantSlug) {
    const tenant = await resolveTenantBySlug(user.tenantSlug);
    const session = await repo.getSessionLastActivity(tenant, user.sessionId);
    if (!session) throw unauthenticated('Session not found');
    if (session.revoked_at) throw unauthenticated('Session revoked');
    const idleMs = Date.now() - new Date(session.last_activity_at).getTime();
    if (idleMs > env.IDLE_TIMEOUT_MINUTES * 60_000) {
      await repo.revokeSession(tenant, user.sessionId, true);
      throw sessionIdle();
    }
    await repo.touchSessionActivity(tenant, user.sessionId);
    return { idle_timeout_minutes: env.IDLE_TIMEOUT_MINUTES, last_activity_at: new Date().toISOString() };
  }
  const last = await platformSvc.getSessionLastActivity(user.sessionId);
  if (!last) throw unauthenticated('Session not found');
  const idleMs = Date.now() - new Date(last).getTime();
  if (idleMs > env.IDLE_TIMEOUT_MINUTES * 60_000) {
    await platformSvc.revokeSession(user.sessionId);
    throw sessionIdle();
  }
  await platformSvc.touchSession(user.sessionId);
  return { idle_timeout_minutes: env.IDLE_TIMEOUT_MINUTES, last_activity_at: new Date().toISOString() };
};

// ---------- change password ----------
export const changePassword = async ({ user, current_password, new_password }) => {
  if (user.tenantSlug) {
    const tenant = await resolveTenantBySlug(user.tenantSlug);
    const row = await repo.findUserById(tenant, user.id);
    if (!row) throw notFound('User not found');
    const ok = await argon2.verify(row.password_hash, current_password);
    if (!ok) throw forbidden('Current password incorrect');
    const hash = await argon2.hash(new_password, HASH_OPTS);
    await repo.updatePasswordHash(tenant, user.id, hash);
    return;
  }
  const pu = await platformSvc.getPlatformUser(user.id);
  const fresh = await platformSvc.verifyPassword({ email: pu.email, password: current_password });
  if (!fresh) throw forbidden('Current password incorrect');
  const { updatePasswordHash: updPlat } = await import('../platform-users/repo.js');
  const hash = await argon2.hash(new_password, HASH_OPTS);
  await updPlat(user.id, hash);
};

export const session = heartbeat;
