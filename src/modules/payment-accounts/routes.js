// Admin-managed payment accounts (bank + UPI) used to collect the admission /
// registration amount. CRUD is restricted to the tenant admin (super_admin).
// Exactly one account is primary at all times; the repo enforces that
// invariant (first account auto-primary, deleting the primary promotes the
// next, can't un-primary the only primary).
import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import * as repo from './repo.js';
import { createSchema, updateSchema, idParam, listQuery, primaryBulkSchema } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// Writes are admin-only. Reads are also available to account managers, who
// need to pick which account a student should pay into when sharing the
// admission form / recording receipts (they can't create/edit accounts).
const adminOnly = requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN);
const readRoles = requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER);

// GET /payment-accounts — list (active by default; ?include_inactive=true for all, ?type=bank|upi)
router.get('/', readRoles, validate({ query: listQuery }), async (req, res, next) => {
  try {
    const rows = await repo.list(req.tenant, req.query);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// GET /payment-accounts/:id
router.get('/:id', readRoles, validate({ params: idParam }), async (req, res, next) => {
  try {
    const row = await repo.findById(req.tenant, req.params.id);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payment account not found' }, meta: { requestId: req.id } });
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// POST /payment-accounts — create (first one is auto-primary)
router.post('/', adminOnly, validate({ body: createSchema }), async (req, res, next) => {
  try {
    const row = await repo.create(req.tenant, req.body, req.user.id);
    res.status(201).json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// PUT /payment-accounts/:id — update
router.put('/:id', adminOnly, validate({ params: idParam, body: updateSchema }), async (req, res, next) => {
  try {
    const row = await repo.update(req.tenant, req.params.id, req.body);
    res.json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// POST /payment-accounts/set-primary — mark one or more accounts primary
// (multiple primaries allowed). Body: { ids: [uuid,...] }.
router.post('/set-primary', adminOnly, validate({ body: primaryBulkSchema }), async (req, res, next) => {
  try {
    const rows = await repo.setPrimaryBulk(req.tenant, req.body.ids);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// POST /payment-accounts/unset-primary — remove primary from one or more
// accounts. Blocked if it would leave zero primaries. Body: { ids: [uuid,...] }.
router.post('/unset-primary', adminOnly, validate({ body: primaryBulkSchema }), async (req, res, next) => {
  try {
    const rows = await repo.unsetPrimaryBulk(req.tenant, req.body.ids);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// DELETE /payment-accounts/:id — soft-delete (promotes next if it was primary)
router.delete('/:id', adminOnly, validate({ params: idParam }), async (req, res, next) => {
  try {
    await repo.remove(req.tenant, req.params.id);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
