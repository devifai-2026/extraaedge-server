import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { teamHierarchy } from '../users/repo.js';
import { SYSTEM_TENANT_ROLES, TEAM_SCOPED_MANAGER_ROLES } from '../../config/constants.js';
import { conflict, forbidden } from '../../lib/errors.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const listQuery = z.object({
  user_id: z.string().uuid().optional(),
  date_from: z.coerce.date().optional(),
  date_to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

// ----------------- Live timer endpoints (start / pause / resume / stop) -----------------

// super_admin doesn't track time
const requireTimedRole = (req, _res, next) => {
  if (req.user.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
    return next(forbidden('super_admin does not track work time'));
  }
  return next();
};

const findOpenSession = async (tenant, userId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT * FROM work_sessions WHERE user_id = $1 AND status IN ('active','paused') LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
};

const stoppedTodayAlready = async (tenant, userId) => {
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

// How long after the last heartbeat we still trust the session is alive.
// Client heartbeats every 60s — 90s grace covers one missed beat + retry.
// Beyond this we treat the session as effectively dead and stop accruing
// active time, which prevents the "paused-overnight = 128h active" bug.
const STALE_GRACE_MS = 90 * 1000;

// Effective "now" for accounting purposes: clamped to ended_at (if stopped)
// or last_heartbeat_at + grace (if the client has gone silent).
const effectiveNow = (row) => {
  const wall = Date.now();
  if (row.ended_at) return new Date(row.ended_at).getTime();
  if (row.last_heartbeat_at) {
    const hbCap = new Date(row.last_heartbeat_at).getTime() + STALE_GRACE_MS;
    return Math.min(wall, hbCap);
  }
  return wall;
};

// Live "active seconds" = elapsed - paused, with every component clamped so
// a corrupt DB row (paused > elapsed, or wildly stale heartbeat) cannot
// produce nonsense like 128h or negative time.
const computeActiveSeconds = (row) => {
  if (!row) return 0;
  const start = new Date(row.started_at).getTime();
  const ref = effectiveNow(row);
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
const computePausedSeconds = (row) => {
  if (!row) return 0;
  const start = new Date(row.started_at).getTime();
  const ref = effectiveNow(row);
  const elapsedMs = Math.max(0, ref - start);
  let pausedMs = Math.max(0, (row.paused_seconds || 0) * 1000);
  if (row.status === 'paused' && row.last_paused_at) {
    const pauseStart = new Date(row.last_paused_at).getTime();
    pausedMs += Math.max(0, ref - pauseStart);
  }
  pausedMs = Math.min(pausedMs, elapsedMs);
  return Math.floor(pausedMs / 1000);
};

router.post('/start', requireTimedRole, async (req, res, next) => {
  try {
    if (await findOpenSession(req.tenant, req.user.id)) {
      throw conflict('A session is already running. Stop it first.');
    }
    if (await stoppedTodayAlready(req.tenant, req.user.id)) {
      throw conflict('You already stopped for the day. Cannot start a new session today.');
    }
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO work_sessions (user_id, started_at, status, last_heartbeat_at, active_minutes)
         VALUES ($1, now(), 'active', now(), 0) RETURNING *`,
      [req.user.id],
    );
    res.status(201).json({ data: { ...rows[0], active_seconds: 0 }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Restart-day: open a brand-new session even though the user already stopped today.
// We keep the prior stopped row(s) intact (so the time-sheet shows both segments)
// and write a marker activity so admins can see this was a manual restart.
router.post('/restart-day', requireTimedRole, async (req, res, next) => {
  try {
    if (await findOpenSession(req.tenant, req.user.id)) {
      throw conflict('A session is already running.');
    }
    const stopped = await stoppedTodayAlready(req.tenant, req.user.id);
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO work_sessions (user_id, started_at, status, last_heartbeat_at, active_minutes, restart_of_day)
         VALUES ($1, now(), 'active', now(), 0, $2) RETURNING *`,
      [req.user.id, stopped],
    );
    res.status(201).json({ data: { ...rows[0], active_seconds: 0, was_restart: stopped }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/pause', requireTimedRole, async (req, res, next) => {
  try {
    const open = await findOpenSession(req.tenant, req.user.id);
    if (!open) throw conflict('No active session to pause');
    if (open.status === 'paused') throw conflict('Session already paused');
    const { rows } = await tenantQuery(
      req.tenant,
      `UPDATE work_sessions SET status='paused', last_paused_at=now(), last_heartbeat_at=now()
         WHERE id=$1 RETURNING *`,
      [open.id],
    );
    res.json({ data: { ...rows[0], active_seconds: computeActiveSeconds(rows[0]) }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/resume', requireTimedRole, async (req, res, next) => {
  try {
    const open = await findOpenSession(req.tenant, req.user.id);
    if (!open) throw conflict('No paused session to resume');
    if (open.status !== 'paused') throw conflict('Session is not paused');
    // Add the pause duration to paused_seconds, clear last_paused_at
    const pausedDelta = open.last_paused_at
      ? Math.floor((Date.now() - new Date(open.last_paused_at).getTime()) / 1000)
      : 0;
    const { rows } = await tenantQuery(
      req.tenant,
      `UPDATE work_sessions
         SET status='active',
             paused_seconds = paused_seconds + $2,
             last_paused_at = NULL,
             last_heartbeat_at = now()
         WHERE id = $1 RETURNING *`,
      [open.id, pausedDelta],
    );
    res.json({ data: { ...rows[0], active_seconds: computeActiveSeconds(rows[0]) }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/stop', requireTimedRole, async (req, res, next) => {
  try {
    const open = await findOpenSession(req.tenant, req.user.id);
    if (!open) throw conflict('No active session to stop');
    // If currently paused, fold last pause into paused_seconds
    let pausedSeconds = open.paused_seconds || 0;
    if (open.status === 'paused' && open.last_paused_at) {
      pausedSeconds += Math.floor((Date.now() - new Date(open.last_paused_at).getTime()) / 1000);
    }
    const totalSeconds = Math.max(0, Math.floor((Date.now() - new Date(open.started_at).getTime()) / 1000) - pausedSeconds);
    const activeMinutes = Math.floor(totalSeconds / 60);
    const { rows } = await tenantQuery(
      req.tenant,
      `UPDATE work_sessions
         SET status='stopped', ended_at=now(), paused_seconds=$2, active_minutes=$3, last_paused_at=NULL
         WHERE id=$1 RETURNING *`,
      [open.id, pausedSeconds, activeMinutes],
    );
    res.json({ data: { ...rows[0], active_seconds: totalSeconds }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/heartbeat', requireTimedRole, async (req, res, next) => {
  try {
    const open = await findOpenSession(req.tenant, req.user.id);
    if (!open) return res.json({ data: { state: 'no_session' }, meta: { requestId: req.id } });
    await tenantQuery(req.tenant, `UPDATE work_sessions SET last_heartbeat_at=now() WHERE id=$1`, [open.id]);
    res.json({ data: { ...open, active_seconds: computeActiveSeconds(open) }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/current', async (req, res, next) => {
  try {
    if (req.user.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
      return res.json({ data: { state: 'untracked' }, meta: { requestId: req.id } });
    }
    const open = await findOpenSession(req.tenant, req.user.id);
    const stoppedToday = await stoppedTodayAlready(req.tenant, req.user.id);
    res.json({
      data: {
        session: open ? { ...open, active_seconds: computeActiveSeconds(open) } : null,
        stopped_today: stoppedToday,
        can_start: !open && !stoppedToday,
      },
      meta: { requestId: req.id },
    });
  } catch (err) { next(err); }
});

// ----------------- Read-only views -----------------

router.get('/me', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM work_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 90`,
      [req.user.id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/me/today', async (req, res, next) => {
  try {
    const { rows: bucketsRows } = await tenantQuery(
      req.tenant,
      `SELECT count(*)::int AS active_minutes FROM work_activity_minutes WHERE user_id = $1 AND minute_bucket >= date_trunc('day', now())`,
      [req.user.id],
    );
    res.json({ data: { active_minutes_today: bucketsRows[0].active_minutes }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ query: listQuery }), async (req, res, next) => {
  try {
    const conds = [];
    const params = [];
    if (TEAM_SCOPED_MANAGER_ROLES.includes(req.user.role)) {
      const ids = await teamHierarchy(req.tenant, req.user.id);
      params.push(ids);
      conds.push(`user_id = ANY($${params.length}::uuid[])`);
    }
    if (req.query.user_id) { params.push(req.query.user_id); conds.push(`user_id = $${params.length}`); }
    if (req.query.date_from) { params.push(req.query.date_from); conds.push(`started_at >= $${params.length}`); }
    if (req.query.date_to) { params.push(req.query.date_to); conds.push(`started_at <= $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT ws.*, u.name AS user_name, u.email AS user_email, u.role AS user_role
         FROM work_sessions ws JOIN users u ON u.id = ws.user_id
         ${where} ORDER BY ws.started_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/team-summary', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try {
    let userIds = null;
    if (TEAM_SCOPED_MANAGER_ROLES.includes(req.user.role)) {
      userIds = await teamHierarchy(req.tenant, req.user.id);
    }
    const params = userIds ? [userIds] : [];
    const filter = userIds ? 'WHERE u.id = ANY($1::uuid[])' : '';
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT u.id, u.name, u.role,
              COALESCE(sum(ws.active_minutes),0)::int AS active_minutes_7d,
              count(ws.id)::int AS session_count_7d,
              COALESCE(AVG(ws.active_minutes),0)::int AS avg_session_minutes
         FROM users u LEFT JOIN work_sessions ws ON ws.user_id = u.id AND ws.started_at > now() - interval '7 days'
        ${filter}
        GROUP BY u.id, u.name, u.role ORDER BY active_minutes_7d DESC`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
