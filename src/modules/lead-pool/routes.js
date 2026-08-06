import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { workTracker } from '../../middleware/workTracker.js';
import { requireClockIn } from '../../middleware/requireClockIn.js';
import { requireTab } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { notFound } from '../../lib/errors.js';
import { maskLeadRow, maskLeadRows } from '../../lib/leadMasking.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import * as service from './service.js';

// Tenant-wide, READ-ONLY Lead Pool. Available to every tenant role that has
// the `lead_pool` tab (counsellors get it by default). Deliberately bypasses
// the owner/team/branch scope that guards modules/leads — a counsellor here
// can look up ANY lead in the tenant by name or phone number, but only sees a
// read-only projection (details + current owner, manager, previous owner).
// No create / update / delete / reassign surface exists on this router.
const router = express.Router();
router.use(authRequired, tenantRequired, workTracker, requireClockIn, requireTab('lead_pool'));

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
    res.json({ data: maskLeadRows(rows, req.user), meta: { requestId: req.id, count: rows.length } });
  } catch (err) { next(err); }
});

// GET /lead-pool/:id — single read-only lead detail (tenant-wide, unscoped).
router.get('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const row = await service.getOne(req.tenant, req.params.id);
    if (!row) return next(notFound('Lead not found'));
    res.json({ data: maskLeadRow(row, req.user), meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Same reveal-audit contract as modules/leads — Lead Pool is a "look up by
// number" tool, so it needs its own reveal action, logged under the same
// action name so the excessive-reveal-rate view catches both surfaces.
router.post('/:id/reveal-phone', validate({ params: idParam }), async (req, res, next) => {
  try {
    const row = await service.getOne(req.tenant, req.params.id);
    if (!row) return next(notFound('Lead not found'));
    await writeAuditLog(req.tenant, {
      userId: req.user.id,
      action: 'lead.phone_revealed',
      entityType: 'lead',
      entityId: row.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({
      data: { phone: row.phone, whatsapp_number: row.whatsapp_number, alternate_contact: row.alternate_contact },
      meta: { requestId: req.id },
    });
  } catch (err) { next(err); }
});

export default router;
