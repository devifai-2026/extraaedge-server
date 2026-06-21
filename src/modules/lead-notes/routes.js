import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import { optimisticLock } from '../../middleware/optimisticLock.js';
import { tenantQuery } from '../../db/tenant.js';
import { notFound, forbidden } from '../../lib/errors.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const leadParam = z.object({ leadId: z.string().uuid() });
const idParam = z.object({ id: z.string().uuid() });
const createSchema = z.object({
  body: z.string().min(1),
  visibility: z.enum(['internal', 'shared']).default('internal'),
  attachments: z.array(z.string().uuid()).optional(),
});
const updateSchema = createSchema.partial();

router.get('/lead/:leadId', validate({ params: leadParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT n.*, u.name AS user_name FROM lead_notes n LEFT JOIN users u ON u.id = n.user_id
        WHERE n.lead_id = $1 AND n.deleted_at IS NULL ORDER BY n.created_at DESC`,
      [req.params.leadId],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/lead/:leadId', validate({ params: leadParam, body: createSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO lead_notes (lead_id, user_id, body, visibility, attachments)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.leadId, req.user.id, req.body.body, req.body.visibility, req.body.attachments ? JSON.stringify(req.body.attachments) : null],
    );
    await tenantQuery(
      req.tenant,
      `INSERT INTO lead_activities (lead_id, user_id, type, summary) VALUES ($1,$2,'note_added',$3)`,
      [req.params.leadId, req.user.id, 'Note added'],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put(
  '/:id',
  validate({ params: idParam, body: updateSchema }),
  optimisticLock(async (req) => {
    const { rows } = await tenantQuery(req.tenant, `SELECT updated_at FROM lead_notes WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    return rows[0]?.updated_at ?? null;
  }),
  async (req, res, next) => {
    try {
      const { rows: existing } = await tenantQuery(req.tenant, `SELECT user_id FROM lead_notes WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
      if (!existing[0]) throw notFound('Note not found');
      if (existing[0].user_id !== req.user.id && req.user.role !== 'super_admin' && req.user.role !== 'branch_manager' && req.user.role !== 'sales_manager') {
        throw forbidden('You can only edit your own notes');
      }
      const fields = [];
      const params = [];
      let i = 1;
      for (const [k, v] of Object.entries(req.body)) {
        if (v === undefined) continue;
        const value = k === 'attachments' ? JSON.stringify(v) : v;
        fields.push(`${k} = $${i}`);
        params.push(value);
        i += 1;
      }
      params.push(req.params.id);
      const { rows } = await tenantQuery(
        req.tenant,
        `UPDATE lead_notes SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
        params,
      );
      res.json({ data: rows[0], meta: { requestId: req.id } });
    } catch (err) { next(err); }
  },
);

router.delete('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows: existing } = await tenantQuery(req.tenant, `SELECT user_id FROM lead_notes WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!existing[0]) throw notFound('Note not found');
    if (existing[0].user_id !== req.user.id && req.user.role !== 'super_admin') throw forbidden('Cannot delete someone else\'s note');
    await tenantQuery(req.tenant, `UPDATE lead_notes SET deleted_at = now() WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
