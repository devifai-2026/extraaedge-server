import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { publish } from '../../lib/queue.js';
import { QUEUE_NAMES, SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { notFound } from '../../lib/errors.js';
import { getDownloadSignedUrl } from '../../lib/r2.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const idParam = z.object({ id: z.string().uuid() });
const jobIdParam = z.object({ job_id: z.string().uuid() });
const dashSchema = z.object({ date_from: z.coerce.date(), date_to: z.coerce.date(), user_id: z.string().uuid().optional() });

// Lead PDF
router.post('/leads/:id/pdf', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO bulk_exports (user_id, filter_json, status) VALUES ($1, $2::jsonb, 'queued') RETURNING *`,
      [req.user.id, JSON.stringify({ kind: 'lead_pdf', lead_id: req.params.id })],
    );
    await publish(QUEUE_NAMES.PDF, 'lead_pdf', { tenantId: req.tenant.id, job_id: rows[0].id, lead_id: req.params.id });
    res.status(202).json({ data: { job_id: rows[0].id }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Dashboard PDF
router.post('/dashboard/pdf', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ body: dashSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO bulk_exports (user_id, filter_json, status) VALUES ($1, $2::jsonb, 'queued') RETURNING *`,
      [req.user.id, JSON.stringify({ kind: 'dashboard_pdf', ...req.body })],
    );
    await publish(QUEUE_NAMES.PDF, 'dashboard_pdf', { tenantId: req.tenant.id, job_id: rows[0].id, params: req.body });
    res.status(202).json({ data: { job_id: rows[0].id }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/:job_id', validate({ params: jobIdParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM bulk_exports WHERE id = $1`, [req.params.job_id]);
    if (!rows[0]) throw notFound('Report not found');
    const data = { ...rows[0] };
    if (rows[0].status === 'completed' && rows[0].file_r2_key) {
      data.signed_url = await getDownloadSignedUrl({ key: rows[0].file_r2_key, downloadAs: `report-${req.params.job_id}.pdf` });
    }
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
