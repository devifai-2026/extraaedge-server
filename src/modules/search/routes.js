import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const searchQuery = z.object({
  q: z.string().min(1),
  context: z.enum(['applicant', 'application']).default('applicant'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const suggestionsQuery = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

// Unified search across leads (name/email/phone), programs, and users.
router.get('/', validate({ query: searchQuery }), async (req, res, next) => {
  try {
    const { q, context, limit } = req.query;
    const pattern = `%${q}%`;
    const [leads, programs, users] = await Promise.all([
      tenantQuery(
        req.tenant,
        `SELECT id, name, email, phone, stage_id, program_id FROM leads
          WHERE deleted_at IS NULL AND (name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1)
          ORDER BY created_at DESC LIMIT $2`,
        [pattern, limit],
      ),
      tenantQuery(
        req.tenant,
        `SELECT id, name, code, category FROM programs WHERE deleted_at IS NULL AND (name ILIKE $1 OR code ILIKE $1) ORDER BY name LIMIT $2`,
        [pattern, Math.min(limit, 10)],
      ),
      tenantQuery(
        req.tenant,
        `SELECT id, name, email, role FROM users WHERE deleted_at IS NULL AND (name ILIKE $1 OR email ILIKE $1) ORDER BY name LIMIT $2`,
        [pattern, Math.min(limit, 10)],
      ),
    ]);
    res.json({
      data: { leads: leads.rows, programs: programs.rows, users: users.rows },
      meta: { requestId: req.id, context },
    });
  } catch (err) { next(err); }
});

router.get('/suggestions', validate({ query: suggestionsQuery }), async (req, res, next) => {
  try {
    const pattern = `${req.query.q}%`;
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT DISTINCT name AS value, 'lead' AS kind FROM leads
        WHERE deleted_at IS NULL AND name ILIKE $1 LIMIT $2`,
      [pattern, req.query.limit],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
