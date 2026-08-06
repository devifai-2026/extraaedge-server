import { tenantQuery } from '../../db/tenant.js';

// How long after the last heartbeat we still trust the session is alive.
// Client heartbeats every 60s — 90s grace covers one missed beat + retry.
// Beyond this we treat the session as effectively dead and stop accruing
// active time, which prevents the "paused-overnight = 128h active" bug.
export const STALE_GRACE_MS = 90 * 1000;

// Effective "now" for accounting purposes: clamped to ended_at (if stopped),
// last_heartbeat_at + grace (if the client has gone silent), or the caller's
// own reference instant (refMs — defaults to live "now", but the midnight
// closer passes tenant-local-midnight so a session isn't credited with
// active time past the day it should have been closed).
export const effectiveNow = (row, refMs = Date.now()) => {
  if (row.ended_at) return new Date(row.ended_at).getTime();
  if (row.last_heartbeat_at) {
    const hbCap = new Date(row.last_heartbeat_at).getTime() + STALE_GRACE_MS;
    return Math.min(refMs, hbCap);
  }
  return refMs;
};

// Active seconds = elapsed - paused, with every component clamped so a
// corrupt DB row (paused > elapsed, or wildly stale heartbeat) cannot
// produce nonsense like 128h or negative time.
export const computeActiveSeconds = (row, refMs = Date.now()) => {
  if (!row) return 0;
  const start = new Date(row.started_at).getTime();
  const ref = effectiveNow(row, refMs);
  const elapsedMs = Math.max(0, ref - start);
  let pausedMs = Math.max(0, (row.paused_seconds || 0) * 1000);
  if (row.status === 'paused' && row.last_paused_at) {
    const pauseStart = new Date(row.last_paused_at).getTime();
    pausedMs += Math.max(0, ref - pauseStart);
  }
  // Hard invariant: paused can never exceed elapsed.
  pausedMs = Math.min(pausedMs, elapsedMs);
  return Math.floor((elapsedMs - pausedMs) / 1000);
};

// Same clamping logic but returns the paused-seconds value to persist.
export const computePausedSeconds = (row, refMs = Date.now()) => {
  if (!row) return 0;
  const start = new Date(row.started_at).getTime();
  const ref = effectiveNow(row, refMs);
  const elapsedMs = Math.max(0, ref - start);
  let pausedMs = Math.max(0, (row.paused_seconds || 0) * 1000);
  if (row.status === 'paused' && row.last_paused_at) {
    const pauseStart = new Date(row.last_paused_at).getTime();
    pausedMs += Math.max(0, ref - pauseStart);
  }
  pausedMs = Math.min(pausedMs, elapsedMs);
  return Math.floor(pausedMs / 1000);
};

export const findOpenSession = async (tenant, userId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT * FROM work_sessions WHERE user_id = $1 AND status IN ('active','paused') LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
};

export const stoppedTodayAlready = async (tenant, userId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT 1 FROM work_sessions
       WHERE user_id = $1 AND status = 'stopped'
         AND started_at >= date_trunc('day', now())
       LIMIT 1`,
    [userId],
  );
  return rows.length > 0;
};

export const isClockedInToday = async (tenant, userId) => Boolean(await findOpenSession(tenant, userId));
