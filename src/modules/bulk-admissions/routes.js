// Accounts-side importer for historical admissions migrated off a previous
// CRM. One spreadsheet row fans out into lead + fee offer + admission + EMI
// schedule + already-collected receipts.
//
// Storage-wise this rides on the same four tables as the counsellor lead
// importer (bulk_import_previews / bulk_imports / bulk_import_failures /
// bulk_import_duplicates), discriminated by the `kind` column. Every query
// below pins kind='admissions' so the two importers never show each other's
// rows — including the /imports/:id lookups, which would otherwise let an
// Accounts user open a lead import by guessing its id.
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
import { buildTemplateXlsx, loadTemplateLookups } from './template-builder.js';
import { HEADERS, EMI_SLOTS, EDU_SLOTS, ADMISSION_STATUSES, TRAINING_MODES, PAYMENT_MODES, COLLECTION_MODES } from './columns.js';

const router = express.Router();

// This importer writes money — receipts, fee offers, admission status. That's
// the accounts team's remit, not a counsellor's, so unlike /bulk/leads it is
// NOT open to the whole tenant.
router.use(
  authRequired,
  tenantRequired,
  requireRole(SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER, SYSTEM_TENANT_ROLES.SUPER_ADMIN),
);

const KIND = 'admissions';

// ---------- TEMPLATE ----------
router.get('/template', async (req, res, next) => {
  try {
    const lookups = await loadTemplateLookups(tenantQuery, req.tenant);
    const buf = await buildTemplateXlsx(lookups);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="admission-import-template.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

// Machine-readable description of the sheet. The upload dialog reads this to
// render the column checklist without duplicating the contract client-side.
router.get('/template/fields', (_req, res) => {
  res.json({
    data: {
      headers: HEADERS,
      emi_slots: EMI_SLOTS,
      education_slots: EDU_SLOTS,
      required: ['first_name', 'admission_date', 'course', 'mode_of_training', 'status', 'course_fees', 'mode_of_payment'],
      required_one_of: ['email', 'whatsapp_number'],
      enums: {
        status: ADMISSION_STATUSES,
        mode_of_training: TRAINING_MODES,
        mode_of_payment: PAYMENT_MODES,
        collection_mode: COLLECTION_MODES,
      },
    },
  });
});

// ---------- PREVIEW ----------
const previewSchema = z.object({
  r2_key: z.string().min(1),
  // Kept for shape-compatibility with the lead importer's preview row (the
  // column is NOT NULL). This sheet's headers already match the field names
  // exactly, so there is no mapping step and no mapper UI.
  field_mapping: z.record(z.string(), z.string()).default({}),
  defaults: z.record(z.string(), z.any()).default({}),
});

router.post('/preview', validate({ body: previewSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO bulk_import_previews
         (user_id, kind, file_r2_key, field_mapping_json, defaults_json,
          total_rows, valid_rows, invalid_rows, duplicate_rows,
          sample_errors_json, duplicate_matches_json)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,0,0,0,0,'[]'::jsonb,'[]'::jsonb)
       RETURNING *`,
      [req.user.id, KIND, req.body.r2_key, JSON.stringify(req.body.field_mapping), JSON.stringify(req.body.defaults)],
    );
    await publish(QUEUE_NAMES.BULK_ADMISSION_IMPORT, 'preview', { tenantId: req.tenant.id, preview_id: rows[0].id });
    res.status(202).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

const idParam = z.object({ id: z.string().uuid() });

router.get('/previews/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM bulk_import_previews WHERE id = $1 AND kind = $2 AND expires_at > now()`,
      [req.params.id, KIND],
    );
    if (!rows[0]) throw notFound('Preview not found or expired');
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------- COMMIT ----------
const commitSchema = z.object({
  preview_id: z.string().uuid(),
  // 'use_existing' is the default because this is a MIGRATION: the student is
  // very often already in the CRM as a converted lead, and the point of the
  // import is to attach their admission + money history to that lead, not to
  // mint a second copy of the person. 'skip' is for a corrective re-run.
  duplicate_handling: z.enum(['use_existing', 'skip']).default('use_existing'),
  // { "<file name as typed in the sheet>": "<r2 key>" } for student photos and
  // payment proofs. The dialog uploads the images first, then posts the map.
  attachments: z.record(z.string(), z.string()).default({}),
  file_name: z.string().max(255).optional(),
  file_size: z.coerce.number().int().nonnegative().optional(),
});

router.post('/commit', validate({ body: commitSchema }), async (req, res, next) => {
  try {
    const { rows: previewRows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM bulk_import_previews WHERE id = $1 AND kind = $2 AND expires_at > now()`,
      [req.body.preview_id, KIND],
    );
    const preview = previewRows[0];
    if (!preview) throw notFound('Preview not found or expired');

    // The attachment map rides in defaults_json rather than getting its own
    // column: it's per-import scratch data the worker reads once, and the
    // column already exists and is jsonb.
    const defaults = { ...(preview.defaults_json ?? {}), attachments: req.body.attachments };

    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO bulk_imports
         (user_id, kind, preview_id, source, file_r2_key, file_name, file_size,
          field_mapping_json, defaults_json, total_rows, duplicate_handling, status)
       VALUES ($1,$2,$3,'csv',$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,'queued')
       RETURNING *`,
      [
        req.user.id, KIND, preview.id, preview.file_r2_key,
        req.body.file_name ?? null, req.body.file_size ?? null,
        preview.field_mapping_json, JSON.stringify(defaults),
        preview.total_rows, req.body.duplicate_handling,
      ],
    );
    await publish(QUEUE_NAMES.BULK_ADMISSION_IMPORT, 'commit', { tenantId: req.tenant.id, import_id: rows[0].id });
    res.status(202).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------- HISTORY ----------
const importsListQuery = z.object({
  file_name: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

router.get('/imports', validate({ query: importsListQuery }), async (req, res, next) => {
  try {
    const conds = [`i.kind = $1`];
    const params = [KIND];
    if (req.query.file_name) {
      params.push(`%${req.query.file_name}%`);
      conds.push(`(i.file_name ILIKE $${params.length} OR i.file_r2_key ILIKE $${params.length})`);
    }
    const where = `WHERE ${conds.join(' AND ')}`;
    const offset = (req.query.page - 1) * req.query.limit;

    const { rows: countRows } = await tenantQuery(
      req.tenant,
      `SELECT count(*)::int AS total FROM bulk_imports i ${where}`,
      params.slice(),
    );

    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT i.id, i.user_id, i.file_r2_key, i.file_name, i.file_size,
              i.total_rows, i.success_rows, i.failed_rows, i.duplicate_rows,
              i.duplicate_handling,
              -- Same stale-job guard as the lead importer: a queued/processing
              -- row the worker hasn't touched in 15 minutes is shown as failed
              -- so the page never renders a forever-Queued import. (Longer
              -- than the lead importer's 5 minutes — each row here does five
              -- table writes, so a large file legitimately runs longer.)
              CASE
                WHEN i.status IN ('queued', 'processing')
                  AND i.created_at < now() - INTERVAL '15 minutes'
                THEN 'failed'
                ELSE i.status
              END AS status,
              i.started_at, i.completed_at, i.created_at,
              u.name AS uploaded_by_name, u.email AS uploaded_by_email
         FROM bulk_imports i
         LEFT JOIN users u ON u.id = i.user_id
         ${where}
         ORDER BY i.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({
      data: rows,
      meta: { requestId: req.id, page: req.query.page, limit: req.query.limit, total: countRows[0]?.total ?? 0 },
    });
  } catch (err) { next(err); }
});

router.get('/imports/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM bulk_imports WHERE id = $1 AND kind = $2`,
      [req.params.id, KIND],
    );
    if (!rows[0]) throw notFound('Import not found');
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------- FAILED / DUPLICATE ROWS ----------
// The Accounts equivalent of the counsellors' Failed Leads page: two tabs
// over the same two tables, scoped to kind='admissions'. No per-uploader
// scoping here — unlike counsellors, everyone who can reach this router
// (account_manager / super_admin) already sees the whole tenant's money.
const rowsQuery = z.object({
  import_id: z.string().uuid().optional(),
  date_from: z.coerce.date().optional(),
  date_to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// Shared WHERE builder for the two list endpoints. `alias` is the failures /
// duplicates table alias; the import join is always pinned to KIND.
const buildRowsWhere = (alias, q) => {
  const conds = [`i.kind = $1`];
  const params = [KIND];
  if (q.import_id) { params.push(q.import_id); conds.push(`${alias}.import_id = $${params.length}`); }
  // Range is on the parent import's upload time — the natural "date" of a
  // failed row, since both child tables are written in the same job.
  if (q.date_from) { params.push(q.date_from); conds.push(`i.created_at >= $${params.length}::timestamptz`); }
  if (q.date_to)   { params.push(q.date_to);   conds.push(`i.created_at <  ($${params.length}::timestamptz + INTERVAL '1 day')`); }
  return { where: `WHERE ${conds.join(' AND ')}`, params };
};

router.get('/failures', validate({ query: rowsQuery }), async (req, res, next) => {
  try {
    const { where, params } = buildRowsWhere('f', req.query);
    const { rows: countRows } = await tenantQuery(
      req.tenant,
      `SELECT count(*)::int AS total
         FROM bulk_import_failures f JOIN bulk_imports i ON i.id = f.import_id ${where}`,
      params.slice(),
    );
    params.push(req.query.limit, (req.query.page - 1) * req.query.limit);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT f.*, i.file_name, i.created_at AS import_created_at
         FROM bulk_import_failures f
         JOIN bulk_imports i ON i.id = f.import_id
         ${where}
         ORDER BY i.created_at DESC, f.row_number
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({
      data: rows,
      meta: { requestId: req.id, page: req.query.page, limit: req.query.limit, total: countRows[0]?.total ?? 0 },
    });
  } catch (err) { next(err); }
});

router.get('/duplicates', validate({ query: rowsQuery }), async (req, res, next) => {
  try {
    const { where, params } = buildRowsWhere('d', req.query);
    const { rows: countRows } = await tenantQuery(
      req.tenant,
      `SELECT count(*)::int AS total
         FROM bulk_import_duplicates d JOIN bulk_imports i ON i.id = d.import_id ${where}`,
      params.slice(),
    );
    params.push(req.query.limit, (req.query.page - 1) * req.query.limit);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT d.*, i.file_name, i.created_at AS import_created_at,
              l.name AS matched_lead_name, l.email AS matched_lead_email,
              l.phone AS matched_lead_phone,
              -- Whether that matched lead already has an admission tells the
              -- accounts user which of the two duplicate cases they're looking
              -- at: "attached to an existing lead" (fine) vs "this student is
              -- already fully in the system" (nothing to do).
              EXISTS (
                SELECT 1 FROM admissions a
                 WHERE a.lead_id = l.id AND a.deleted_at IS NULL
              ) AS matched_lead_has_admission
         FROM bulk_import_duplicates d
         JOIN bulk_imports i ON i.id = d.import_id
         LEFT JOIN leads l ON l.id = d.matched_lead_id
         ${where}
         ORDER BY i.created_at DESC, d.row_number
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({
      data: rows,
      meta: { requestId: req.id, page: req.query.page, limit: req.query.limit, total: countRows[0]?.total ?? 0 },
    });
  } catch (err) { next(err); }
});

// Counts for the two tab headers.
router.get('/summary', validate({ query: rowsQuery.omit({ page: true, limit: true }) }), async (req, res, next) => {
  try {
    const f = buildRowsWhere('f', req.query);
    const d = buildRowsWhere('d', req.query);
    const [failures, duplicates] = await Promise.all([
      tenantQuery(
        req.tenant,
        `SELECT count(*)::int AS n FROM bulk_import_failures f
           JOIN bulk_imports i ON i.id = f.import_id ${f.where}`,
        f.params,
      ),
      tenantQuery(
        req.tenant,
        `SELECT count(*)::int AS n FROM bulk_import_duplicates d
           JOIN bulk_imports i ON i.id = d.import_id ${d.where}`,
        d.params,
      ),
    ]);
    res.json({
      data: { failures: failures.rows[0]?.n ?? 0, duplicates: duplicates.rows[0]?.n ?? 0 },
      meta: { requestId: req.id },
    });
  } catch (err) { next(err); }
});

// Clear rows the operator has dealt with. Delete-only (no inline edit /
// retry): the fix-up workflow for this importer is "correct the spreadsheet,
// re-upload" — a partially-edited failure row can't recreate the money
// history the original row described.
const bulkDeleteSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

const bulkDeleteRows = (table, alias) => async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `DELETE FROM ${table} ${alias}
        USING bulk_imports i
        WHERE ${alias}.import_id = i.id AND i.kind = $1 AND ${alias}.id = ANY($2::uuid[])
        RETURNING ${alias}.id`,
      [KIND, req.body.ids],
    );
    res.json({ data: { deleted: rows.length, requested: req.body.ids.length }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
};

router.post('/failures/bulk-delete', validate({ body: bulkDeleteSchema }), bulkDeleteRows('bulk_import_failures', 'f'));
router.post('/duplicates/bulk-delete', validate({ body: bulkDeleteSchema }), bulkDeleteRows('bulk_import_duplicates', 'd'));

// Failures for one specific import (drill-down from the import history row).
router.get('/imports/:id/failures', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT f.*
         FROM bulk_import_failures f
         JOIN bulk_imports i ON i.id = f.import_id AND i.kind = $2
        WHERE f.import_id = $1
        ORDER BY f.row_number
        LIMIT 1000`,
      [req.params.id, KIND],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Re-download the spreadsheet as originally uploaded, so an operator can fix
// the failed rows in the same file they submitted.
router.get('/imports/:id/file', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT file_r2_key, file_name FROM bulk_imports WHERE id = $1 AND kind = $2`,
      [req.params.id, KIND],
    );
    const imp = rows[0];
    if (!imp) throw notFound('Import not found');
    if (!imp.file_r2_key) throw notFound('Original file is no longer available');
    const { getDownloadSignedUrl } = await import('../../lib/r2.js');
    const url = await getDownloadSignedUrl({
      key: imp.file_r2_key,
      downloadAs: imp.file_name || imp.file_r2_key.split('/').pop(),
    });
    res.json({ data: { url, file_name: imp.file_name }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
