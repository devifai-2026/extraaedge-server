import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { shortCode } from '../../lib/crypto.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { notFound } from '../../lib/errors.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const idParam = z.object({ id: z.string().uuid() });
const leadParam = z.object({ leadId: z.string().uuid() });

// Lead referral codes
router.get('/lead/:leadId/codes', validate({ params: leadParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM lead_referral_codes WHERE lead_id = $1 AND deleted_at IS NULL`, [req.params.leadId]);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/lead/:leadId/codes', validate({ params: leadParam, body: z.object({ max_uses: z.coerce.number().int().positive().optional(), expires_at: z.coerce.date().optional() }) }), async (req, res, next) => {
  try {
    const code = shortCode(8);
    const landingUrl = `${process.env.BASE_URL || ''}/r/${code}`;
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO lead_referral_codes (lead_id, code, landing_url, max_uses, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.leadId, code, landingUrl, req.body.max_uses ?? null, req.body.expires_at ?? null],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/codes/:id', validate({ params: idParam }), async (req, res, next) => {
  try { await tenantQuery(req.tenant, `UPDATE lead_referral_codes SET deleted_at = now() WHERE id = $1`, [req.params.id]); res.status(204).end(); }
  catch (err) { next(err); }
});

router.get('/lead/:leadId/referrals', validate({ params: leadParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT id, name, email, phone, created_at, referral_code_used FROM leads WHERE referred_by_lead_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [req.params.leadId],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/lead/:leadId/referred-by', validate({ params: leadParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT r.id, r.name, r.email, r.phone FROM leads l
         LEFT JOIN leads r ON r.id = l.referred_by_lead_id
        WHERE l.id = $1`,
      [req.params.leadId],
    );
    res.json({ data: rows[0]?.id ? rows[0] : null, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Referral policies
const policySchema = z.object({
  name: z.string().min(1),
  trigger: z.enum(['lead_created', 'payment_succeeded', 'enrolled']),
  credit_type: z.enum(['points', 'cash', 'discount', 'custom']),
  credit_amount: z.coerce.number().positive(),
  credit_currency: z.string().optional(),
  is_active: z.boolean().default(true),
});

router.get('/policies', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try { const { rows } = await tenantQuery(req.tenant, `SELECT * FROM referral_policies WHERE deleted_at IS NULL ORDER BY trigger`); res.json({ data: rows, meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});

router.post('/policies', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ body: policySchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO referral_policies (name, trigger, credit_type, credit_amount, credit_currency, is_active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.body.name, req.body.trigger, req.body.credit_type, req.body.credit_amount, req.body.credit_currency ?? null, req.body.is_active],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/policies/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam, body: policySchema.partial() }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) { if (v === undefined) continue; fields.push(`${k} = $${i}`); params.push(v); i += 1; }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE referral_policies SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING *`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/policies/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam }), async (req, res, next) => {
  try { await tenantQuery(req.tenant, `UPDATE referral_policies SET deleted_at = now() WHERE id = $1`, [req.params.id]); res.status(204).end(); }
  catch (err) { next(err); }
});

// Credits
router.get('/credits', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try {
    const status = req.query.status;
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT rc.*, rl.name AS referrer_name, rdl.name AS referred_name
         FROM referral_credits rc
         LEFT JOIN leads rl ON rl.id = rc.referrer_lead_id
         LEFT JOIN leads rdl ON rdl.id = rc.referred_lead_id
        ${status ? 'WHERE rc.status = $1' : ''}
        ORDER BY rc.triggered_at DESC LIMIT 500`,
      status ? [status] : [],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/credits/:id/credit', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `UPDATE referral_credits SET status = 'credited', credited_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`,
      [req.params.id],
    );
    if (!rows[0]) throw notFound('Pending credit not found');
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/credits/:id/revoke', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam, body: z.object({ reason: z.string().optional() }) }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `UPDATE referral_credits SET status = 'revoked', revoked_at = now(), revoked_reason = $2 WHERE id = $1 RETURNING *`,
      [req.params.id, req.body.reason ?? null],
    );
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// All referrals overview
router.get('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT rc.referrer_lead_id, rl.name AS referrer_name,
              count(*)::int AS total_referrals,
              count(*) FILTER (WHERE rc.status='credited')::int AS credited,
              sum(rc.credit_amount)::numeric AS total_credit
         FROM referral_credits rc JOIN leads rl ON rl.id = rc.referrer_lead_id
        GROUP BY rc.referrer_lead_id, rl.name ORDER BY total_credit DESC NULLS LAST LIMIT 200`,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
