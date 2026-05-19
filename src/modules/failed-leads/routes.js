import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { teamHierarchy } from '../users/repo.js';
import { forbidden } from '../../lib/errors.js';

const router = express.Router();
// All three tenant roles can view the failed-leads page; counsellors see it
// to fix their own bulk uploads and managers/admins see it for everyone's.
router.use(authRequired, tenantRequired, requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER, SYSTEM_TENANT_ROLES.COUNSELLOR));

// Returns either null (super_admin — sees everything) or an array of
// allowed bulk_imports.user_id values for this viewer:
//   counsellor    → [own id]
//   sales_manager → own id + every user reporting under them (recursive)
//   super_admin   → null (no filter)
const scopeFor = async (req) => {
  const { role, id } = req.user;
  if (role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) return null;
  if (role === SYSTEM_TENANT_ROLES.SALES_MANAGER) {
    return await teamHierarchy(req.tenant, id);
  }
  return [id];
};

// Confirm a specific failure / duplicate row's underlying import was
// uploaded by someone the actor can see. Used by write endpoints (retry,
// update, delete) so a counsellor can't tamper with a peer's failures.
const assertCanActOn = async (req, importIdSql, idValue) => {
  const allowed = await scopeFor(req);
  if (allowed === null) return; // super_admin: anything goes
  const { rows } = await tenantQuery(
    req.tenant,
    `SELECT i.user_id FROM bulk_imports i WHERE i.id = ${importIdSql}`,
    [idValue],
  );
  if (!rows[0]) throw forbidden('Row not found or not yours');
  if (!allowed.includes(rows[0].user_id)) throw forbidden('Row belongs to another user');
};

const listQuery = z.object({
  import_id: z.string().uuid().optional(),
  // Date range filter. Applied against bulk_imports.created_at (when the file
  // was uploaded) — the natural "date" of a failed row, since the underlying
  // bulk_import_failures / bulk_import_duplicates rows are created in the
  // same transaction as the import. Both bounds are optional and inclusive.
  // Format: ISO date or datetime (z.coerce.date accepts both).
  date_from: z.coerce.date().optional(),
  date_to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const summaryQuery = z.object({
  import_id: z.string().uuid().optional(),
  date_from: z.coerce.date().optional(),
  date_to: z.coerce.date().optional(),
});
const idParam = z.object({ id: z.string().uuid() });

router.get('/', validate({ query: listQuery }), async (req, res, next) => {
  try {
    const conds = [];
    const params = [];
    if (req.query.import_id) { params.push(req.query.import_id); conds.push(`f.import_id = $${params.length}`); }
    // Date range filter on the parent import's upload time. date_to is
    // treated as inclusive end-of-day when a date-only value is supplied,
    // so the picker can be a simple date picker without time inputs.
    if (req.query.date_from) { params.push(req.query.date_from); conds.push(`i.created_at >= $${params.length}::timestamptz`); }
    if (req.query.date_to)   { params.push(req.query.date_to);   conds.push(`i.created_at <  ($${params.length}::timestamptz + INTERVAL '1 day')`); }
    // Scope to imports the viewer is allowed to see.
    const scope = await scopeFor(req);
    if (scope !== null) { params.push(scope); conds.push(`i.user_id = ANY($${params.length}::uuid[])`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT f.*, i.created_at AS import_created_at
         FROM bulk_import_failures f
         JOIN bulk_imports i ON i.id = f.import_id
         ${where}
         ORDER BY f.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id, page: req.query.page, limit: req.query.limit } });
  } catch (err) { next(err); }
});

// Retry route was removed — retrying individual rows had unclear semantics
// (validation-only retries skipped the resolver entirely) and the workflow
// is now: bulk-delete bad rows, fix the spreadsheet, re-upload. The
// scheduler's retry_row job consumer is still wired but never receives
// jobs from this route; it can be removed in a follow-up.

const editSchema = z.object({ raw_row_json: z.record(z.string(), z.any()) });
router.put('/:id', validate({ params: idParam, body: editSchema }), async (req, res, next) => {
  try {
    await assertCanActOn(req, '(SELECT import_id FROM bulk_import_failures WHERE id = $1)', req.params.id);
    await tenantQuery(
      req.tenant,
      `UPDATE bulk_import_failures SET raw_row_json = $2::jsonb WHERE id = $1`,
      [req.params.id, JSON.stringify(req.body.raw_row_json)],
    );
    res.status(204).end();
  } catch (err) { next(err); }
});

router.delete('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    await assertCanActOn(req, '(SELECT import_id FROM bulk_import_failures WHERE id = $1)', req.params.id);
    await tenantQuery(req.tenant, `DELETE FROM bulk_import_failures WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// Bulk-delete validation failures. Scoping rule: a counsellor / manager
// can only delete rows from their own (or their team's) imports, same as
// the single-row delete. Rows owned by someone outside scope are silently
// skipped — the response reports how many were actually deleted so the UI
// can show a clear "deleted X of Y" toast.
const bulkDeleteSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });
router.post('/bulk-delete', validate({ body: bulkDeleteSchema }), async (req, res, next) => {
  try {
    const allowed = await scopeFor(req);
    const params = [req.body.ids];
    let where = `f.id = ANY($1::uuid[])`;
    if (allowed !== null) { params.push(allowed); where += ` AND i.user_id = ANY($${params.length}::uuid[])`; }
    const { rows } = await tenantQuery(
      req.tenant,
      `DELETE FROM bulk_import_failures f
        USING bulk_imports i
        WHERE f.import_id = i.id AND ${where}
        RETURNING f.id`,
      params,
    );
    res.json({ data: { deleted: rows.length, requested: req.body.ids.length }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------- DUPLICATES ----------
// Rows that matched an existing lead during bulk import. Listed separately
// from validation failures because the data is valid — it just clashes
// with what's already in the system.
router.get('/duplicates', validate({ query: listQuery }), async (req, res, next) => {
  try {
    const conds = [];
    const params = [];
    if (req.query.import_id) { params.push(req.query.import_id); conds.push(`d.import_id = $${params.length}`); }
    if (req.query.date_from) { params.push(req.query.date_from); conds.push(`i.created_at >= $${params.length}::timestamptz`); }
    if (req.query.date_to)   { params.push(req.query.date_to);   conds.push(`i.created_at <  ($${params.length}::timestamptz + INTERVAL '1 day')`); }
    const scope = await scopeFor(req);
    if (scope !== null) { params.push(scope); conds.push(`i.user_id = ANY($${params.length}::uuid[])`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT d.*, i.created_at AS import_created_at,
              l.name AS matched_lead_name, l.email AS matched_lead_email, l.phone AS matched_lead_phone
         FROM bulk_import_duplicates d
         JOIN bulk_imports i ON i.id = d.import_id
         LEFT JOIN leads l ON l.id = d.matched_lead_id
         ${where}
         ORDER BY d.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id, page: req.query.page, limit: req.query.limit } });
  } catch (err) { next(err); }
});

router.delete('/duplicates/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    await assertCanActOn(req, '(SELECT import_id FROM bulk_import_duplicates WHERE id = $1)', req.params.id);
    await tenantQuery(req.tenant, `DELETE FROM bulk_import_duplicates WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// Bulk-delete duplicates — same scoping + response shape as the failures
// bulk-delete above.
router.post('/duplicates/bulk-delete', validate({ body: bulkDeleteSchema }), async (req, res, next) => {
  try {
    const allowed = await scopeFor(req);
    const params = [req.body.ids];
    let where = `d.id = ANY($1::uuid[])`;
    if (allowed !== null) { params.push(allowed); where += ` AND i.user_id = ANY($${params.length}::uuid[])`; }
    const { rows } = await tenantQuery(
      req.tenant,
      `DELETE FROM bulk_import_duplicates d
        USING bulk_imports i
        WHERE d.import_id = i.id AND ${where}
        RETURNING d.id`,
      params,
    );
    res.json({ data: { deleted: rows.length, requested: req.body.ids.length }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Counts for the page header tabs ("Validation Errors (3)" + "Duplicates (12)").
// Optionally scoped to a single import_id.
router.get('/summary', validate({ query: summaryQuery }), async (req, res, next) => {
  try {
    const conds = [];
    const params = [];
    if (req.query.import_id) { params.push(req.query.import_id); conds.push(`x.import_id = $${params.length}`); }
    if (req.query.date_from) { params.push(req.query.date_from); conds.push(`i.created_at >= $${params.length}::timestamptz`); }
    if (req.query.date_to)   { params.push(req.query.date_to);   conds.push(`i.created_at <  ($${params.length}::timestamptz + INTERVAL '1 day')`); }
    const scope = await scopeFor(req);
    if (scope !== null) { params.push(scope); conds.push(`i.user_id = ANY($${params.length}::uuid[])`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const [failures, duplicates] = await Promise.all([
      tenantQuery(
        req.tenant,
        `SELECT count(*)::int AS n
           FROM bulk_import_failures x
           JOIN bulk_imports i ON i.id = x.import_id
           ${where}`,
        params,
      ),
      tenantQuery(
        req.tenant,
        `SELECT count(*)::int AS n
           FROM bulk_import_duplicates x
           JOIN bulk_imports i ON i.id = x.import_id
           ${where}`,
        params,
      ),
    ]);
    res.json({
      data: {
        failures: failures.rows[0].n,
        duplicates: duplicates.rows[0].n,
      },
      meta: { requestId: req.id },
    });
  } catch (err) { next(err); }
});

export default router;
