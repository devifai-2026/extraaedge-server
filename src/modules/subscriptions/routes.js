import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { sysQuery } from '../../db/system.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// Plan + credits overview
router.get('/', async (req, res, next) => {
  try {
    const { rows: planRows } = await sysQuery(
      `SELECT t.plan_id, p.name AS plan_name, p.features_json, p.included_email_credits, p.included_sms_credits, p.included_whatsapp_credits, t.trial_ends_at, t.subscription_ends_at
         FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`,
      [req.tenant.id],
    );
    const { rows: credits } = await tenantQuery(req.tenant, `SELECT * FROM subscription_credits ORDER BY credit_type`);
    res.json({ data: { plan: planRows[0] ?? null, credits }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/usage', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT
         count(*) FILTER (WHERE channel='email' AND sent_at > now() - interval '30 days')::int AS email_30d,
         count(*) FILTER (WHERE channel='sms' AND sent_at > now() - interval '30 days')::int AS sms_30d,
         count(*) FILTER (WHERE channel='whatsapp' AND sent_at > now() - interval '30 days')::int AS whatsapp_30d
       FROM message_log`,
    );
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

const rechargeSchema = z.object({
  credit_type: z.enum(['email', 'sms', 'whatsapp_business', 'whatsapp_session']),
  amount: z.coerce.number().positive(),
});

router.post('/recharge', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ body: rechargeSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO subscription_credits (credit_type, balance, monthly_allocation, last_recharge_at)
       VALUES ($1, $2, 0, now())
       ON CONFLICT (credit_type) DO UPDATE SET balance = subscription_credits.balance + EXCLUDED.balance, last_recharge_at = now()
       RETURNING *`,
      [req.body.credit_type, req.body.amount],
    );
    await tenantQuery(
      req.tenant,
      `INSERT INTO credit_transactions (credit_type, amount, reason) VALUES ($1,$2,'recharge')`,
      [req.body.credit_type, req.body.amount],
    );
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/transactions', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM credit_transactions ORDER BY created_at DESC LIMIT 500`);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/plan', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ body: z.object({ plan_id: z.string().uuid() }) }), async (req, res, next) => {
  try {
    // Tenants request a plan change — creates a ticket for product_owner to process.
    await tenantQuery(
      req.tenant,
      `INSERT INTO tickets (user_id, subject, category, priority, description, status)
       VALUES ($1, 'Plan change request', 'billing', 'normal', $2, 'open')`,
      [req.user.id, `Request plan change to ${req.body.plan_id}`],
    );
    res.json({ data: { requested: true }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
