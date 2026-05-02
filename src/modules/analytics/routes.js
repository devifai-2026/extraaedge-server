// Analytics endpoints used by the dashboard. Every query is role-scoped:
//   counsellor    → only leads they own
//   sales_manager → leads owned by their team hierarchy
//   super_admin   → no filter
//
// Counts of *outbound* communications are also restricted to the actor's scope
// for non-admins (their own messages or messages to their leads).
import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { teamHierarchy } from '../users/repo.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const rangeQuery = z.object({
  date_from: z.coerce.date().optional(),
  date_to: z.coerce.date().optional(),
  user_id: z.string().uuid().optional(),
  program_id: z.string().uuid().optional(),
});

// Resolve the actor's lead-visibility scope. null = no filter (admin).
const computeScope = async (req) => {
  const actor = req.user;
  if (!actor || actor.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) return null;
  if (actor.role === SYSTEM_TENANT_ROLES.SALES_MANAGER) {
    const ids = await teamHierarchy(req.tenant, actor.id);
    return { user_ids: ids };
  }
  return { user_ids: [actor.id] };
};

// Build a WHERE-condition list. `leadAlias` lets callers join leads under any
// alias (`l`, `leads`, etc.). Each call returns: { conds: [], params: [] }.
const buildLeadConds = (q, scope, leadAlias = '') => {
  const a = leadAlias ? `${leadAlias}.` : '';
  const conds = [];
  const params = [];
  if (q.date_from) { params.push(q.date_from); conds.push(`${a}created_at >= $${params.length}`); }
  if (q.date_to)   { params.push(q.date_to);   conds.push(`${a}created_at <= $${params.length}`); }
  if (q.user_id)   { params.push(q.user_id);   conds.push(`${a}assigned_to = $${params.length}`); }
  if (q.program_id){ params.push(q.program_id); conds.push(`${a}program_id = $${params.length}`); }
  if (scope && scope.user_ids) {
    params.push(scope.user_ids);
    conds.push(`${a}assigned_to = ANY($${params.length}::uuid[])`);
  }
  return { conds, params };
};

// ---------- Summary ----------
router.get('/summary', validate({ query: rangeQuery }), async (req, res, next) => {
  try {
    const scope = await computeScope(req);
    const { conds, params } = buildLeadConds(req.query, scope);
    conds.push('deleted_at IS NULL');
    const where = conds.join(' AND ');

    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT
         count(*)::int AS total_leads,
         count(*) FILTER (WHERE converted_at IS NOT NULL)::int AS converted,
         count(DISTINCT program_id) FILTER (WHERE program_id IS NOT NULL)::int AS programs_active,
         count(*) FILTER (WHERE is_cold)::int AS cold_leads
       FROM leads WHERE ${where}`,
      params,
    );

    // Communication counts — scoped for non-admins (only their own sends).
    const userScopeClause = scope?.user_ids ? `AND user_id = ANY($1::uuid[])` : '';
    const userScopeParams = scope?.user_ids ? [scope.user_ids] : [];
    const [emailN, smsN, waN] = await Promise.all([
      tenantQuery(req.tenant, `SELECT count(*)::int n FROM message_log WHERE channel='email'    AND sent_at > now() - interval '30 days' ${userScopeClause}`, userScopeParams),
      tenantQuery(req.tenant, `SELECT count(*)::int n FROM message_log WHERE channel='sms'      AND sent_at > now() - interval '30 days' ${userScopeClause}`, userScopeParams),
      tenantQuery(req.tenant, `SELECT count(*)::int n FROM message_log WHERE channel='whatsapp' AND sent_at > now() - interval '30 days' ${userScopeClause}`, userScopeParams),
    ]);
    const s = rows[0];
    const conversion = s.total_leads ? Math.round((s.converted / s.total_leads) * 100) : 0;
    res.json({
      data: {
        total_leads: s.total_leads,
        converted: s.converted,
        conversion_rate_pct: conversion,
        programs_active: s.programs_active,
        cold_leads: s.cold_leads,
        comms_30d: { email: emailN.rows[0].n, sms: smsN.rows[0].n, whatsapp: waN.rows[0].n },
      },
      meta: { requestId: req.id },
    });
  } catch (err) { next(err); }
});

// ---------- Funnel by stage ----------
router.get('/funnel', validate({ query: rangeQuery }), async (req, res, next) => {
  try {
    const scope = await computeScope(req);
    const { conds, params } = buildLeadConds(req.query, scope, 'l');
    conds.push('l.deleted_at IS NULL');
    const where = conds.join(' AND ');
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT s.id AS stage_id, s.name AS stage, s.code, s.order_index, count(l.id)::int AS count
         FROM lead_stages s LEFT JOIN leads l ON l.stage_id = s.id AND ${where}
        WHERE s.deleted_at IS NULL
        GROUP BY s.id, s.name, s.code, s.order_index
        ORDER BY s.order_index`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------- Time series ----------
router.get('/leads-timeline', validate({ query: rangeQuery }), async (req, res, next) => {
  try {
    const scope = await computeScope(req);
    const { conds, params } = buildLeadConds(req.query, scope);
    conds.push('deleted_at IS NULL');
    const where = conds.join(' AND ');
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT date_trunc('day', created_at) AS day, count(*)::int AS leads FROM leads WHERE ${where} GROUP BY 1 ORDER BY 1`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------- Program-wise conversion ----------
router.get('/program-wise', validate({ query: rangeQuery }), async (req, res, next) => {
  try {
    const scope = await computeScope(req);
    const { conds, params } = buildLeadConds(req.query, scope, 'l');
    conds.push('l.deleted_at IS NULL');
    const where = conds.join(' AND ');
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT p.id, p.name, count(l.id)::int AS leads,
              count(l.id) FILTER (WHERE l.converted_at IS NOT NULL)::int AS converted
         FROM programs p LEFT JOIN leads l ON l.program_id = p.id AND ${where}
        WHERE p.deleted_at IS NULL
        GROUP BY p.id, p.name ORDER BY leads DESC`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------- Channel × Source ----------
router.get('/channel-source', validate({ query: rangeQuery }), async (req, res, next) => {
  try {
    const scope = await computeScope(req);
    const { conds, params } = buildLeadConds(req.query, scope);
    conds.push('deleted_at IS NULL');
    const where = conds.join(' AND ');
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT COALESCE(first_touch_channel, 'Direct') AS channel,
              COALESCE(first_touch_source,  'Unknown') AS source,
              count(*)::int AS leads,
              count(*) FILTER (WHERE converted_at IS NOT NULL)::int AS converted
         FROM leads WHERE ${where} GROUP BY 1,2 ORDER BY leads DESC LIMIT 100`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------- Program × Stage ----------
router.get('/program-status', validate({ query: rangeQuery }), async (req, res, next) => {
  try {
    const scope = await computeScope(req);
    const { conds, params } = buildLeadConds(req.query, scope, 'l');
    conds.push('l.deleted_at IS NULL');
    const where = conds.join(' AND ');
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT p.id, p.name, COALESCE(s.name, 'No Stage') AS stage, count(l.id)::int AS leads
         FROM programs p
         JOIN leads l ON l.program_id = p.id AND ${where}
         LEFT JOIN lead_stages s ON s.id = l.stage_id
        WHERE p.deleted_at IS NULL
        GROUP BY p.id, p.name, s.name ORDER BY p.name, leads DESC`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------- Cold reasons ----------
router.get('/cold-enquiries', async (req, res, next) => {
  try {
    const scope = await computeScope(req);
    const params = [];
    let scopeClause = '';
    if (scope?.user_ids) {
      params.push(scope.user_ids);
      scopeClause = `AND assigned_to = ANY($${params.length}::uuid[])`;
    }
    const [bucket, daily] = await Promise.all([
      tenantQuery(
        req.tenant,
        `SELECT COALESCE(NULLIF(closure_remarks, ''), 'Unspecified') AS reason,
                count(*)::int AS leads
           FROM leads WHERE is_cold AND deleted_at IS NULL
                  AND created_at > now() - interval '90 days' ${scopeClause}
          GROUP BY 1 ORDER BY leads DESC LIMIT 10`,
        params,
      ),
      tenantQuery(
        req.tenant,
        `SELECT count(*)::int AS n, date_trunc('day', created_at) AS day
           FROM leads WHERE is_cold AND deleted_at IS NULL
                  AND created_at > now() - interval '90 days' ${scopeClause}
          GROUP BY 2 ORDER BY 2`,
        params,
      ),
    ]);
    res.json({ data: { reasons: bucket.rows, daily: daily.rows }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------- Counsellor leaderboard (manager / admin only) ----------
router.get('/counselor-performance', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try {
    const scope = await computeScope(req);
    const params = [];
    let userClause = '';
    if (scope?.user_ids) {
      params.push(scope.user_ids);
      userClause = `AND u.id = ANY($${params.length}::uuid[])`;
    }
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT u.id, u.name,
              count(l.id) FILTER (WHERE l.assigned_to = u.id AND l.deleted_at IS NULL)::int AS assigned_leads,
              count(l.id) FILTER (WHERE l.assigned_to = u.id AND l.converted_at IS NOT NULL)::int AS converted,
              count(DISTINCT c.id) FILTER (WHERE c.user_id = u.id AND c.started_at > now() - interval '30 days')::int AS calls_30d,
              count(DISTINCT ml.id) FILTER (WHERE ml.user_id = u.id AND ml.sent_at > now() - interval '30 days')::int AS messages_30d
         FROM users u
         LEFT JOIN leads l ON l.assigned_to = u.id
         LEFT JOIN calls c ON c.user_id = u.id
         LEFT JOIN message_log ml ON ml.user_id = u.id
        WHERE u.deleted_at IS NULL AND u.role = 'counsellor' ${userClause}
        GROUP BY u.id, u.name ORDER BY converted DESC NULLS LAST`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------- Communications breakdown ----------
// Combines email/sms/whatsapp from `message_log` with calls from `calls`. Each
// row: { channel, status, n }. `channel='call'` rows encode inbound/outbound
// in the status (`inbound_completed`, `outbound_missed`, …) so the chart can
// stack them.
router.get('/communications', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try {
    const scope = await computeScope(req);
    const params = [];
    let userClause = '';
    if (scope?.user_ids) {
      params.push(scope.user_ids);
      userClause = `AND user_id = ANY($${params.length}::uuid[])`;
    }
    const { rows } = await tenantQuery(
      req.tenant,
      `(
         SELECT channel, status, count(*)::int AS n
           FROM message_log
          WHERE sent_at > now() - interval '30 days' ${userClause}
          GROUP BY channel, status
       )
       UNION ALL
       (
         SELECT 'call'::text AS channel,
                COALESCE(direction, 'outbound') || '_' || COALESCE(status, 'unknown') AS status,
                count(*)::int AS n
           FROM calls
          WHERE deleted_at IS NULL
            AND COALESCE(started_at, created_at) > now() - interval '30 days'
            ${userClause}
          GROUP BY direction, status
       )
       ORDER BY channel, status`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------- Login counts per day ----------
// Daily login + logout counts per user for the last N days. Self-only for
// counsellors, team-only for sales managers, all for super admins.
router.get('/login-events', async (req, res, next) => {
  try {
    const scope = await computeScope(req);
    const userId = req.query.user_id || null;
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10), 1), 365);
    const params = [];
    const conds = [`created_at > now() - interval '${days} days'`];
    if (userId) {
      params.push(userId);
      conds.push(`user_id = $${params.length}`);
    } else if (scope?.user_ids) {
      params.push(scope.user_ids);
      conds.push(`user_id = ANY($${params.length}::uuid[])`);
    }
    const where = `WHERE ${conds.join(' AND ')}`;
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
              user_id,
              count(*) FILTER (WHERE kind = 'login')::int  AS logins,
              count(*) FILTER (WHERE kind = 'logout')::int AS logouts
         FROM user_login_events
         ${where}
         GROUP BY 1, 2
         ORDER BY day DESC`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
