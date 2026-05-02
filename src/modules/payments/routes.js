import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired, tenantOptional } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery, tenantTx } from '../../db/tenant.js';
import { createPaymentLink, verifyWebhookSignature, normalizeWebhook } from '../../lib/providers/payment-razorpay.js';
import { publish } from '../../lib/queue.js';
import { QUEUE_NAMES, EVENT_TYPES, SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { notFound } from '../../lib/errors.js';

const router = express.Router();

// Razorpay webhook — raw body needed for signature check.
router.post('/webhook/razorpay',
  express.raw({ type: 'application/json', limit: '1mb' }),
  tenantOptional,
  async (req, res, next) => {
    try {
      const rawBody = req.body.toString('utf8');
      const sig = req.headers['x-razorpay-signature'] || '';
      if (!verifyWebhookSignature({ rawBody, receivedSignature: sig })) {
        return res.status(401).json({ error: { code: 'INVALID_SIGNATURE' } });
      }
      if (!req.tenant) return res.status(400).json({ error: { code: 'TENANT_REQUIRED' } });
      const event = JSON.parse(rawBody);
      const n = normalizeWebhook(event);

      await tenantQuery(
        req.tenant,
        `INSERT INTO payment_webhook_log (provider, event_type, signature, body_json, received_at)
         VALUES ('razorpay', $1, $2, $3::jsonb, now())`,
        [n.event_type, sig, rawBody],
      );

      if (n.provider_payment_id && n.status) {
        await tenantTx(req.tenant, async (client) => {
          // Link payment to lead via payment_links.
          let lead_id = null;
          if (n.provider_link_id) {
            const { rows: linkRows } = await client.query(`SELECT lead_id FROM payment_links WHERE provider_link_id = $1`, [n.provider_link_id]);
            lead_id = linkRows[0]?.lead_id ?? null;
            const linkStatus = n.status === 'captured' ? 'paid' : n.status === 'failed' ? 'cancelled' : 'created';
            await client.query(`UPDATE payment_links SET status = $2 WHERE provider_link_id = $1`, [n.provider_link_id, linkStatus]);
          }
          await client.query(
            `INSERT INTO payments (lead_id, payment_link_id, amount, currency, provider, provider_payment_id, status, method, paid_at, raw_webhook_json)
             VALUES ($1, (SELECT id FROM payment_links WHERE provider_link_id = $2 LIMIT 1), $3, $4, 'razorpay', $5, $6, $7, $8, $9::jsonb)
             ON CONFLICT (provider_payment_id) DO UPDATE SET
                status = EXCLUDED.status, paid_at = EXCLUDED.paid_at, raw_webhook_json = EXCLUDED.raw_webhook_json`,
            [lead_id, n.provider_link_id, n.amount, n.currency, n.provider_payment_id, n.status, n.method ?? null, n.occurred_at, rawBody],
          );
          if (lead_id && n.status === 'captured') {
            await client.query(
              `INSERT INTO lead_activities (lead_id, type, summary, metadata_json)
               VALUES ($1,'payment_received',$2,$3::jsonb)`,
              [lead_id, `Payment received: ${n.amount} ${n.currency}`, JSON.stringify(n)],
            );
            await client.query(`UPDATE leads SET converted_at = COALESCE(converted_at, now()) WHERE id = $1`, [lead_id]);
          }
        });

        const eventType = n.status === 'captured' ? EVENT_TYPES.PAYMENT_SUCCEEDED : n.status === 'failed' ? EVENT_TYPES.PAYMENT_FAILED : EVENT_TYPES.PAYMENT_CREATED;
        await publish(QUEUE_NAMES.EVENTS, eventType, {
          type: eventType,
          tenantId: req.tenant.id,
          occurredAt: new Date().toISOString(),
          entityType: 'payment',
          entityId: n.provider_payment_id,
          payload: n,
        });
      }

      await tenantQuery(req.tenant, `UPDATE payment_webhook_log SET processed_at = now() WHERE signature = $1`, [sig]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  },
);

router.use(authRequired, tenantRequired);

const linkSchema = z.object({
  lead_id: z.string().uuid(),
  amount: z.coerce.number().positive(),
  currency: z.string().default('INR'),
  description: z.string().optional(),
  expires_in_hours: z.coerce.number().int().positive().optional(),
});

router.post('/links', validate({ body: linkSchema }), async (req, res, next) => {
  try {
    const { rows: [lead] } = await tenantQuery(req.tenant, `SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL`, [req.body.lead_id]);
    if (!lead) throw notFound('Lead not found');
    const expires = req.body.expires_in_hours ? new Date(Date.now() + req.body.expires_in_hours * 3600_000) : null;
    const providerResp = await createPaymentLink({
      amount: req.body.amount,
      currency: req.body.currency,
      reference_id: `${req.tenant.slug}-${req.body.lead_id}-${Date.now()}`,
      description: req.body.description ?? `Payment for ${lead.name}`,
      customer: { email: lead.email, contact: lead.phone, name: lead.name },
    });
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO payment_links (lead_id, amount, currency, provider, provider_link_id, short_url, description, status, expires_at, created_by)
       VALUES ($1,$2,$3,'razorpay',$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.body.lead_id, req.body.amount, req.body.currency, providerResp.provider_link_id, providerResp.short_url, req.body.description ?? null, providerResp.status, expires, req.user.id],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/links', async (req, res, next) => {
  try {
    const conds = [];
    const params = [];
    if (req.query.lead_id) { params.push(req.query.lead_id); conds.push(`lead_id = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM payment_links ${where} ORDER BY created_at DESC LIMIT 500`, params);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const conds = [];
    const params = [];
    if (req.query.lead_id) { params.push(req.query.lead_id); conds.push(`lead_id = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); conds.push(`status = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM payments ${where} ORDER BY paid_at DESC NULLS LAST LIMIT 500`, params);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/:id/refund', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: z.object({ id: z.string().uuid() }) }), async (req, res, next) => {
  try {
    // Refund marker; actual refund call to Razorpay should be added when the flow is defined.
    const { rows } = await tenantQuery(req.tenant, `UPDATE payments SET status = 'refunded', refunded_at = now() WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!rows[0]) throw notFound('Payment not found');
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
