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

// The registry of phones running the APK. Distinct from `accounts` above,
// which is derived from login history: a device that has stopped working
// still has a login record, so accounts alone can never show WHY the
// recordings dried up. This can — a revoked permission, battery optimisation
// switched back on, an old app version, or simply a phone that stopped
// checking in.
const tenantDevices = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT d.id, d.device_id, d.manufacturer, d.model, d.os_version, d.app_version,
            d.permissions, d.first_seen_at, d.last_seen_at,
            d.sync_requested_at, d.sync_started_at, d.sync_completed_at, d.sync_result,
            u.id AS user_id, u.name AS user_name, u.phone AS user_phone, u.role AS user_role
       FROM recorder_devices d
       LEFT JOIN users u ON u.id = d.user_id
      ORDER BY d.last_seen_at DESC NULLS LAST`,
  );
  return rows;
};

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
    // Per-day / per-counsellor / per-device breakdown — the granularity the
    // PO console's trend chart + "who's actually uploading, and did it
    // match" drill-down need. rows_inserted stays for back-compat with
    // anything still reading the old shape; matched/unmatched/multi is the
    // split the daily chart stacks.
    tenantQuery(
      tenant,
      `SELECT date_trunc('day', dr.uploaded_at)::date AS day,
              ${UPLOADER_KEY} AS uploader_phone,
              u.name AS user_name,
              dr.device_id,
              count(*)::int AS rows_inserted,
              count(*) FILTER (WHERE dr.match_status = 'matched')::int AS matched,
              count(*) FILTER (WHERE dr.match_status = 'unmatched')::int AS unmatched,
              count(*) FILTER (WHERE dr.match_status = 'multi')::int AS multi
         FROM device_recordings dr
         LEFT JOIN users u ON u.id = dr.uploaded_by
        WHERE dr.deleted_at IS NULL AND dr.uploaded_at > now() - interval '14 days'
        GROUP BY 1, 2, 3, 4
        ORDER BY 1 DESC, 5 DESC`,
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
        const [m, devices] = await Promise.all([tenantMetrics(tenant), tenantDevices(tenant)]);
        return { ...base, ...m, devices, error: null };
      } catch (err) {
        return { ...base, accounts: [], uploaders: [], daily: [], devices: [], error: err.message };
      }
    }));

    const totals = perTenant.reduce(
      (acc, t) => {
        acc.app_accounts += t.accounts.length;
        acc.rows_inserted += t.uploaders.reduce((s, u) => s + u.rows_inserted, 0);
        acc.tenants_configured += t.recorder_folder_path ? 1 : 0;
        acc.devices += t.devices.length;
        // "Healthy" = checked in within 24h AND holding the one permission
        // without which the app cannot see a single recording. Anything else
        // is a phone the PO needs to chase, so the headline counts the gap
        // rather than the total.
        acc.devices_healthy += t.devices.filter((d) => (
          d.last_seen_at && (Date.now() - new Date(d.last_seen_at).getTime()) < 86_400_000
          && d.permissions?.all_files === true
        )).length;
        return acc;
      },
      {
        app_accounts: 0, rows_inserted: 0, tenants_configured: 0,
        devices: 0, devices_healthy: 0, tenants: perTenant.length,
      },
    );

    res.json({ data: { totals, tenants: perTenant }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// "Pull all recordings now" — the product owner's remote trigger.
//
// Stamping a timestamp is the whole mechanism. These phones have no push
// channel, so the device collects the request on its next heartbeat, runs the
// upload it already knows how to do, and stamps the result back. Clearing the
// previous run's start/completion is what makes the button re-pressable: it
// resets the request/ack pair so a second press is a fresh command rather
// than one the device believes it has already served.
router.post('/tenants/:tenantId/devices/:deviceId/request-sync', async (req, res, next) => {
  try {
    const tenant = await resolveTenantById(req.params.tenantId);
    if (!tenant) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tenant not found' } });
    const { rows } = await tenantQuery(
      tenant,
      `UPDATE recorder_devices
          SET sync_requested_at = now(),
              sync_requested_by = $2,
              sync_started_at   = NULL,
              sync_completed_at = NULL,
              sync_result       = NULL
        WHERE id = $1
        RETURNING id, device_id, sync_requested_at`,
      [req.params.deviceId, req.user?.id ?? null],
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Device not found' } });
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
