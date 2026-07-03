import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireTab } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { notFound } from '../../lib/errors.js';
import * as service from './service.js';

// Tenant-wide, READ-ONLY Lead Pool. Available to every tenant role that has
// the `lead_pool` tab (counsellors get it by default). Deliberately bypasses
// the owner/team/branch scope that guards modules/leads — a counsellor here
// can look up ANY lead in the tenant by name or phone number, but only sees a
// read-only projection (details + current owner, manager, previous owner).
// No create / update / delete / reassign surface exists on this router.
const router = express.Router();
router.use(authRequired, tenantRequired, requireTab('lead_pool'));

const searchQuery = z.object({
  // Free-text: lead name OR phone number (with or without a 91 / +91 prefix).
  q: z.string().trim().min(1, 'Enter a name or phone number to search'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const idParam = z.object({ id: z.string().uuid() });

// GET /lead-pool?q=...&limit=...  — search the whole tenant.
router.get('/', validate({ query: searchQuery }), async (req, res, next) => {
  try {
    const rows = await service.search(req.tenant, req.query);
    res.json({ data: rows, meta: { requestId: req.id, count: rows.length } });
  } catch (err) { next(err); }
});

// GET /lead-pool/:id — single read-only lead detail (tenant-wide, unscoped).
router.get('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const row = await service.getOne(req.tenant, req.params.id);
    if (!row) return next(notFound('Lead not found'));
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
