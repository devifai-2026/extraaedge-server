import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const rangeQuery = z.object({
  date_from: z.coerce.date().optional(),
  date_to: z.coerce.date().optional(),
  user_id: z.string().uuid().optional(),
  program_id: z.string().uuid().optional(),
});

const rangeClause = (q, params, ts = 'created_at') => {
  const conds = [];
  if (q.date_from) { params.push(q.date_from); conds.push(`${ts} >= $${params.length}`); }
  if (q.date_to) { params.push(q.date_to); conds.push(`${ts} <= $${params.length}`); }
  if (q.user_id) { params.push(q.user_id); conds.push(`assigned_to = $${params.length}`); }
  if (q.program_id) { params.push(q.program_id); conds.push(`program_id = $${params.length}`); }
  return conds;
};

router.get('/summary', validate({ query: rangeQuery }), async (req, res, next) => {
  try {
    const params = [];
    const where = rangeClause(req.query, params).concat(['deleted_at IS NULL']).join(' AND ');
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
    const [emailN, smsN, waN] = await Promise.all([
      tenantQuery(req.tenant, `SELECT count(*)::int n FROM message_log WHERE channel='email' AND sent_at > now() - interval '30 days'`),
      tenantQuery(req.tenant, `SELECT count(*)::int n FROM message_log WHERE channel='sms' AND sent_at > now() - interval '30 days'`),
      tenantQuery(req.tenant, `SELECT count(*)::int n FROM message_log WHERE channel='whatsapp' AND sent_at > now() - interval '30 days'`),
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

router.get('/funnel', validate({ query: rangeQuery }), async (req, res, next) => {
  try {
    const params = [];
    const where = rangeClause(req.query, params).concat(['l.deleted_at IS NULL']).join(' AND ');
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

router.get('/leads-timeline', validate({ query: rangeQuery }), async (req, res, next) => {
  try {
    const params = [];
    const where = rangeClause(req.query, params).concat(['deleted_at IS NULL']).join(' AND ');
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT date_trunc('day', created_at) AS day, count(*)::int AS leads FROM leads WHERE ${where} GROUP BY 1 ORDER BY 1`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/program-wise', validate({ query: rangeQuery }), async (req, res, next) => {
  try {
    const params = [];
    const where = rangeClause(req.query, params).concat(['l.deleted_at IS NULL']).join(' AND ');
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

router.get('/channel-source', validate({ query: rangeQuery }), async (req, res, next) => {
  try {
    const params = [];
    const where = rangeClause(req.query, params).concat(['deleted_at IS NULL']).join(' AND ');
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT first_touch_channel AS channel, first_touch_source AS source, count(*)::int AS leads
         FROM leads WHERE ${where} GROUP BY 1,2 ORDER BY leads DESC LIMIT 100`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/program-status', validate({ query: rangeQuery }), async (req, res, next) => {
  try {
    const params = [];
    const where = rangeClause(req.query, params).concat(['l.deleted_at IS NULL']).join(' AND ');
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT p.id, p.name, s.name AS stage, count(l.id)::int AS leads
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

router.get('/cold-enquiries', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT count(*)::int AS n, date_trunc('day', created_at) AS day
         FROM leads WHERE is_cold AND deleted_at IS NULL AND created_at > now() - interval '90 days'
         GROUP BY 2 ORDER BY 2`,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/counselor-performance', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try {
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
        WHERE u.deleted_at IS NULL AND u.role = 'counsellor'
        GROUP BY u.id, u.name ORDER BY converted DESC NULLS LAST`,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/communications', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT channel, status, count(*)::int AS n
         FROM message_log WHERE sent_at > now() - interval '30 days'
         GROUP BY channel, status ORDER BY channel, status`,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
