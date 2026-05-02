import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { encrypt } from '../../lib/crypto.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { notImplemented } from '../../lib/errors.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const idParam = z.object({ id: z.string().uuid() });

// Audiences
router.get('/audiences', async (req, res, next) => {
  try { const { rows } = await tenantQuery(req.tenant, `SELECT * FROM fb_audiences WHERE deleted_at IS NULL ORDER BY created_at DESC`); res.json({ data: rows, meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});

const audSchema = z.object({
  fb_ad_account_id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  audience_filter_json: z.record(z.string(), z.any()),
});

router.post('/audiences', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ body: audSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO fb_audiences (fb_ad_account_id, name, description, audience_filter_json, created_by)
       VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING *`,
      [req.body.fb_ad_account_id, req.body.name, req.body.description ?? null, JSON.stringify(req.body.audience_filter_json), req.user.id],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/audiences/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam, body: audSchema.partial() }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined) continue;
      const val = k === 'audience_filter_json' ? JSON.stringify(v) : v;
      fields.push(`${k} = $${i}`); params.push(val); i += 1;
    }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE fb_audiences SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING *`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/audiences/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam }), async (req, res, next) => {
  try { await tenantQuery(req.tenant, `UPDATE fb_audiences SET deleted_at = now() WHERE id = $1`, [req.params.id]); res.status(204).end(); }
  catch (err) { next(err); }
});

router.post('/audiences/:id/sync', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  // TODO: push audience to Facebook Marketing API via stored credentials.
  // For now mark as pending — a dedicated remarketing-sync worker picks it up.
  try {
    await tenantQuery(req.tenant, `UPDATE fb_audiences SET sync_status = 'pending' WHERE id = $1`, [req.params.id]);
    res.status(202).json({ data: { queued: true }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Ad accounts
router.get('/accounts', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try { const { rows } = await tenantQuery(req.tenant, `SELECT id, ad_account_id, name, connected_at FROM fb_ad_accounts WHERE deleted_at IS NULL ORDER BY name`); res.json({ data: rows, meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});

router.post('/accounts/connect', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), (_req, res, next) => next(notImplemented('OAuth connect flow needs Facebook app credentials')));
router.get('/accounts/callback', (_req, res, next) => next(notImplemented('OAuth callback — pending FB app setup')));

export default router;
