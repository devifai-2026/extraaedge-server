// Forces closed any work_sessions still open once the tenant's local day has
// ended — the "forgot to clock out" case leadership wants counted against
// staff monthly. The live app.js/WorkTimer.jsx midnight auto-stop is a
// client-side setTimeout that never fires if the tab/laptop is closed; this
// is the real, server-side backstop.
//
// Runs every 5 minutes rather than exactly at midnight — cheap idempotent
// poll, correct regardless of poll cadence since "has tenant-local midnight
// passed since started_at" is computed in SQL per tenant timezone, not by
// comparing to the tick time.
import { sysQuery } from '../db/system.js';
import { tenantQuery } from '../db/tenant.js';
import { computeActiveSeconds, computePausedSeconds } from '../modules/work-sessions/repo.js';
import { logger } from '../lib/logger.js';

const findStaleOpenSessions = (tenant) =>
  tenantQuery(
    tenant,
    `SELECT ws.*,
            (date_trunc('day', ws.started_at AT TIME ZONE $1) AT TIME ZONE $1) + interval '1 day' AS local_midnight
       FROM work_sessions ws
      WHERE ws.status IN ('active', 'paused')
        AND (date_trunc('day', ws.started_at AT TIME ZONE $1) AT TIME ZONE $1) + interval '1 day' <= now()`,
    [tenant.timezone || 'Asia/Kolkata'],
  );

const closeSession = (tenant, row, midnightMs) => {
  const activeSeconds = computeActiveSeconds(row, midnightMs);
  const pausedSeconds = computePausedSeconds(row, midnightMs);
  const endedAt = new Date(Math.min(midnightMs, Date.now()));
  return tenantQuery(
    tenant,
    `UPDATE work_sessions
        SET status = 'stopped', ended_at = $2, paused_seconds = $3, active_minutes = $4,
            last_paused_at = NULL, auto_closed = true, closed_reason = 'auto_midnight'
      WHERE id = $1`,
    [row.id, endedAt, pausedSeconds, Math.floor(activeSeconds / 60)],
  );
};

const tick = async () => {
  try {
    // Full row, not just id/timezone — tenantQuery's getTenantPool needs
    // status + the db connection fields, or it always throws "suspended"
    // (an incomplete tenant object's .status is undefined, which fails the
    // `!== 'active'` check) even though the WHERE clause already filters to
    // real active tenants. This silently broke every tick since the worker
    // shipped — caught per-tenant so it never crashed, which is exactly why
    // it went unnoticed instead of erroring loudly.
    const { rows: tenants } = await sysQuery(
      `SELECT id, slug, status, db_name, db_user, db_password_encrypted, timezone
         FROM tenants WHERE status = 'active' AND deleted_at IS NULL`,
    );
    for (const tenant of tenants) {
      try {
        const { rows: stale } = await findStaleOpenSessions(tenant);
        for (const row of stale) {
          await closeSession(tenant, row, new Date(row.local_midnight).getTime());
        }
        if (stale.length) {
          logger.info({ tenantId: tenant.id, count: stale.length }, 'work-session-midnight-closer: auto-closed stale sessions');
        }
      } catch (err) {
        logger.error({ tenantId: tenant.id, err: err.message }, 'work-session-midnight-closer failed for tenant');
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'work-session-midnight-closer failed');
  }
};

setInterval(tick, 5 * 60_000);
setTimeout(tick, 30_000);
