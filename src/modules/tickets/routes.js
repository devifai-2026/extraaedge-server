import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { notFound } from '../../lib/errors.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const createSchema = z.object({
  subject: z.string().min(1),
  category: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  description: z.string().optional(),
  attachments: z.array(z.string().uuid()).optional(),
});
const commentSchema = z.object({ body: z.string().min(1), attachments: z.array(z.string().uuid()).optional() });
const idParam = z.object({ id: z.string().uuid() });

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM tickets WHERE deleted_at IS NULL AND (user_id = $1 OR $2 IN ('super_admin','sales_manager')) ORDER BY created_at DESC LIMIT 500`,
      [req.user.id, req.user.role],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/', validate({ body: createSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO tickets (user_id, subject, category, priority, description, attachments, status)
       VALUES ($1,$2,$3,$4,$5,$6,'open') RETURNING *`,
      [req.user.id, req.body.subject, req.body.category ?? null, req.body.priority, req.body.description ?? null, req.body.attachments ? JSON.stringify(req.body.attachments) : null],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM tickets WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!rows[0]) throw notFound('Ticket not found');
    const { rows: comments } = await tenantQuery(
      req.tenant,
      `SELECT tc.*, u.name AS user_name FROM ticket_comments tc LEFT JOIN users u ON u.id = tc.user_id WHERE ticket_id = $1 ORDER BY created_at`,
      [req.params.id],
    );
    res.json({ data: { ...rows[0], comments }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/:id/comments', validate({ params: idParam, body: commentSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO ticket_comments (ticket_id, user_id, body, attachments) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, req.user.id, req.body.body, req.body.attachments ? JSON.stringify(req.body.attachments) : null],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
