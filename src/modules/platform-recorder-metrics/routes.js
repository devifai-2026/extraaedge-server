// Recorder-app metrics for the product-owner console.
//
// Cross-tenant view of the counsellor Android recorder rollout:
//   - "accounts": who has set up the APK (successful mobile-OTP logins per
//     user, from otp_verifications purpose='mobile_login' verified_at set —
//     request-otp invalidates stale codes by expiring them, so verified_at
//     is only ever a real login)
//   - "uploaders": per counsellor sign-up number, how many device_recordings
//     rows were inserted (matched / unmatched / multi) and when the last
//     upload landed
//   - "daily": the daily-sync ledger — rows inserted per day per number for
//     the last 14 days
//
// device_recordings lives in each tenant DB, so this loops every active
// tenant (same resolve+query pattern as platform-lead-inspector); a tenant
// whose DB is unreachable reports an error string instead of failing the
// whole payload.
import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { requirePlatformRole } from '../../middleware/rbac.js';
import { PLATFORM_ROLES } from '../../config/constants.js';
import { sysQuery } from '../../db/system.js';
import { resolveTenantById, tenantQuery } from '../../db/tenant.js';

const router = express.Router();
router.use(authRequired, requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER));

// COALESCE chain: JWT uploads carry uploaded_by (join users for the phone),
// legacy api-key uploads carry counsellor_phone, oldest rows only a device id.
const UPLOADER_KEY = `coalesce(u.phone, dr.counsellor_phone, dr.device_id, 'unknown')`;

const tenantMetrics = async (tenant) => {
  const [{ rows: accounts }, { rows: uploaders }, { rows: daily }] = await Promise.all([
    tenantQuery(
      tenant,
      `SELECT u.id AS user_id, u.name, u.phone, u.role,
              count(*)::int AS logins,
              min(ov.verified_at) AS first_login_at,
              max(ov.verified_at) AS last_login_at
         FROM otp_verifications ov
         JOIN users u ON u.id = ov.user_id
        WHERE ov.purpose = 'mobile_login' AND ov.verified_at IS NOT NULL
        GROUP BY u.id, u.name, u.phone, u.role
        ORDER BY max(ov.verified_at) DESC`,
    ),
    tenantQuery(
      tenant,
      `SELECT ${UPLOADER_KEY} AS uploader_phone,
              u.name AS user_name,
              count(*)::int AS rows_inserted,
              count(*) FILTER (WHERE dr.match_status = 'matched')::int AS matched,
              count(*) FILTER (WHERE dr.match_status = 'unmatched')::int AS unmatched,
              count(*) FILTER (WHERE dr.match_status = 'multi')::int AS multi,
              max(dr.uploaded_at) AS last_upload_at
         FROM device_recordings dr
         LEFT JOIN users u ON u.id = dr.uploaded_by
        WHERE dr.deleted_at IS NULL
        GROUP BY 1, 2
        ORDER BY rows_inserted DESC`,
    ),
    tenantQuery(
      tenant,
      `SELECT date_trunc('day', dr.uploaded_at)::date AS day,
              ${UPLOADER_KEY} AS uploader_phone,
              count(*)::int AS rows_inserted
         FROM device_recordings dr
         LEFT JOIN users u ON u.id = dr.uploaded_by
        WHERE dr.deleted_at IS NULL AND dr.uploaded_at > now() - interval '14 days'
        GROUP BY 1, 2
        ORDER BY 1 DESC, 3 DESC`,
    ),
  ]);
  return { accounts, uploaders, daily };
};

router.get('/', async (req, res, next) => {
  try {
    const { rows: tenants } = await sysQuery(
      `SELECT id, slug, name, recorder_folder_path, recorder_sync_hour
         FROM tenants
        WHERE deleted_at IS NULL AND status = 'active'
        ORDER BY slug`,
    );

    const perTenant = await Promise.all(tenants.map(async (t) => {
      const base = {
        tenant_id: t.id,
        slug: t.slug,
        name: t.name,
        recorder_folder_path: t.recorder_folder_path ?? null,
        recorder_sync_hour: t.recorder_sync_hour ?? 21,
      };
      try {
        const tenant = await resolveTenantById(t.id);
        const m = await tenantMetrics(tenant);
        return { ...base, ...m, error: null };
      } catch (err) {
        return { ...base, accounts: [], uploaders: [], daily: [], error: err.message };
      }
    }));

    const totals = perTenant.reduce(
      (acc, t) => {
        acc.app_accounts += t.accounts.length;
        acc.rows_inserted += t.uploaders.reduce((s, u) => s + u.rows_inserted, 0);
        acc.tenants_configured += t.recorder_folder_path ? 1 : 0;
        return acc;
      },
      { app_accounts: 0, rows_inserted: 0, tenants_configured: 0, tenants: perTenant.length },
    );

    res.json({ data: { totals, tenants: perTenant }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
