import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery, tenantTx } from '../../db/tenant.js';
import { publish } from '../../lib/queue.js';
import { QUEUE_NAMES, SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { notFound } from '../../lib/errors.js';

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildTemplateXlsx, loadTemplateLookups } from './template-builder.js';

const router = express.Router();
// All authenticated tenant users (including counsellors) may upload leads.
router.use(authRequired, tenantRequired, requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER, SYSTEM_TENANT_ROLES.COUNSELLOR));

// Serve the bulk-lead template. The xlsx variant is generated live from
// the tenant's current dropdown values so users pick stage / sub_stage /
// country from a real Excel dropdown — no typos, no failed rows for
// strict-match fields. Pass ?format=csv for the static CSV (no dropdowns).
router.get('/template', async (req, res, next) => {
  try {
    if (req.query.format === 'csv') {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const csvPath = path.resolve(here, '../../../docs/bulk-lead-template.csv');
      const body = await readFile(csvPath, 'utf8');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="bulk-lead-template.csv"');
      return res.send(body);
    }
    const lookups = await loadTemplateLookups(tenantQuery, req.tenant);
    const buf = await buildTemplateXlsx(lookups);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="bulk-lead-template.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

// Returns a JSON description of every supported column — UI renders a field mapper against this.
router.get('/template/fields', (_req, res) => {
  res.json({
    data: {
      required_one_of: ['first_name', 'email', 'phone', 'whatsapp_number'],
      groups: [
        { name: 'personal', fields: ['first_name', 'last_name', 'email', 'alternate_email', 'phone', 'whatsapp_number', 'alternate_contact', 'gender', 'language'] },
        { name: 'education', fields: ['ug_degree', 'ug_specialization', 'ug_university', 'ug_graduation_year', 'pg_degree', 'pg_specialization', 'pg_university', 'pg_graduation_year'] },
        { name: 'address', fields: ['country', 'state', 'district', 'city', 'address', 'pincode'] },
        { name: 'program_pipeline', fields: ['program', 'stage', 'sub_stage', 'remarks'] },
        { name: 'family', fields: ['father_name', 'father_mobile', 'father_email', 'mother_name', 'mother_mobile', 'mother_email', 'guardian_name', 'guardian_mobile', 'guardian_email'] },
        { name: 'source', fields: ['channel', 'source', 'primary_source', 'campaign', 'medium'] },
        { name: 'ownership', fields: ['assigned_to_email', 'current_lead_owner_email', 'previous_lead_owner_email'] },
        { name: 'referrals', fields: ['referral_code_used'] },
        { name: 'tags', fields: ['tags'] },
      ],
    },
  });
});

const previewSchema = z.object({
  r2_key: z.string().min(1),
  field_mapping: z.record(z.string(), z.string()),
  defaults: z.record(z.string(), z.any()).default({}),
});

const commitSchema = z.object({
  preview_id: z.string().uuid(),
  // 'create_new' was removed deliberately: it let an operator insert a second
  // lead for a person who already exists, which then collides with the
  // phone/email/whatsapp uniqueness guards (or, worse, slips in as a true
  // duplicate for phone-less rows) and later gets auto-merged — silently
  // losing the more-progressed copy's stage/owner. Duplicates must be either
  // skipped (default) or used to update the existing lead. Never re-created.
  duplicate_handling: z.enum(['skip', 'update_existing']).default('skip'),
  send_welcome_email: z.boolean().default(false),
  send_welcome_sms: z.boolean().default(false),
  // Optional human-readable file name (e.g. "april-leads.xlsx"). Stored on
  // bulk_imports.file_name so the bulk-upload list page can show something
  // friendlier than the storage key. Capped to keep weird values out.
  file_name: z.string().max(255).optional(),
  file_size: z.coerce.number().int().nonnegative().optional(),
});

const downloadSchema = z.object({
  filter_json: z.record(z.string(), z.any()).default({}),
  columns: z.array(z.string()).optional(),
  cc_emails: z.array(z.string().email()).optional(),
  bcc_emails: z.array(z.string().email()).optional(),
});

const statusChangeSchema = z.object({
  lead_ids: z.array(z.string().uuid()).min(1).max(5000),
  stage_id: z.string().uuid(),
  sub_stage_id: z.string().uuid().optional(),
});

const referSchema = z.object({
  lead_ids: z.array(z.string().uuid()).min(1).max(5000),
  assigned_to: z.string().uuid(),
  reason: z.string().optional(),
});

const idParam = z.object({ id: z.string().uuid() });

// ---------- PREVIEW ----------
router.post('/preview', validate({ body: previewSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO bulk_import_previews (user_id, file_r2_key, field_mapping_json, defaults_json, total_rows, valid_rows, invalid_rows, duplicate_rows, sample_errors_json, duplicate_matches_json)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,0,0,0,0,'[]'::jsonb,'[]'::jsonb) RETURNING *`,
      [req.user.id, req.body.r2_key, JSON.stringify(req.body.field_mapping), JSON.stringify(req.body.defaults)],
    );
    // Queue the preview job — worker downloads the CSV, counts rows, detects duplicates, populates the preview.
    await publish(QUEUE_NAMES.BULK_IMPORT, 'preview', { tenantId: req.tenant.id, preview_id: rows[0].id });
    res.status(202).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/previews/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM bulk_import_previews WHERE id = $1 AND expires_at > now()`, [req.params.id]);
    if (!rows[0]) throw notFound('Preview not found or expired');
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------- COMMIT ----------
router.post('/commit', validate({ body: commitSchema }), async (req, res, next) => {
  try {
    const { rows: previewRows } = await tenantQuery(req.tenant, `SELECT * FROM bulk_import_previews WHERE id = $1 AND expires_at > now()`, [req.body.preview_id]);
    const preview = previewRows[0];
    if (!preview) throw notFound('Preview not found or expired');
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO bulk_imports (user_id, preview_id, source, file_r2_key, file_name, file_size, field_mapping_json, defaults_json, total_rows, duplicate_handling, status, send_welcome_email, send_welcome_sms)
       VALUES ($1,$2,'csv',$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,'queued',$10,$11) RETURNING *`,
      [
        req.user.id, preview.id, preview.file_r2_key,
        req.body.file_name ?? null, req.body.file_size ?? null,
        preview.field_mapping_json, preview.defaults_json, preview.total_rows,
        req.body.duplicate_handling, req.body.send_welcome_email, req.body.send_welcome_sms,
      ],
    );
    await publish(QUEUE_NAMES.BULK_IMPORT, 'commit', { tenantId: req.tenant.id, import_id: rows[0].id });
    res.status(202).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// List of bulk imports visible to the actor, scoped by role:
//   super_admin   → all imports in the tenant
//   sales_manager → own + every uploader reporting under them (recursive)
//   counsellor    → own only
//
// Optional query filters: ?file_name=&user_id=&page=&limit=
// `file_name` runs as case-insensitive ILIKE; `user_id` exact-matches the
// uploader. Counts are returned alongside rows for client-side pagination.
const importsListQuery = z.object({
  file_name: z.string().optional(),
  user_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const allowedUploaderIds = async (req) => {
  if (req.user.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) return null;
  if (req.user.role === SYSTEM_TENANT_ROLES.SALES_MANAGER) {
    const { teamHierarchy } = await import('../users/repo.js');
    return await teamHierarchy(req.tenant, req.user.id);
  }
  return [req.user.id];
};

router.get('/imports', validate({ query: importsListQuery }), async (req, res, next) => {
  try {
    const allowed = await allowedUploaderIds(req);
    const conds = [];
    const params = [];
    if (allowed !== null) { params.push(allowed); conds.push(`i.user_id = ANY($${params.length}::uuid[])`); }
    if (req.query.file_name) {
      params.push(`%${req.query.file_name}%`);
      // Match the user-supplied file name first, fall back to the storage
      // key (so old rows without file_name still work).
      conds.push(`(i.file_name ILIKE $${params.length} OR i.file_r2_key ILIKE $${params.length})`);
    }
    if (req.query.user_id) {
      // Don't let a counsellor / manager bypass scoping by passing a
      // user_id outside their allowed set.
      if (allowed !== null && !allowed.includes(req.query.user_id)) {
        return res.json({ data: [], meta: { requestId: req.id, page: req.query.page, limit: req.query.limit, total: 0 } });
      }
      params.push(req.query.user_id);
      conds.push(`i.user_id = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (req.query.page - 1) * req.query.limit;

    const countParams = params.slice();
    const { rows: countRows } = await tenantQuery(
      req.tenant,
      `SELECT count(*)::int AS total FROM bulk_imports i ${where}`,
      countParams,
    );

    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT i.id, i.user_id, i.source, i.file_r2_key, i.file_name, i.file_size,
              i.total_rows, i.success_rows, i.failed_rows, i.duplicate_rows,
              i.duplicate_handling,
              -- Auto-fail stale queued/processing rows. If the worker hasn't
              -- moved them in 5 minutes we treat them as failed for display
              -- so the UI never shows a forever-Queued row.
              CASE
                WHEN i.status IN ('queued', 'processing')
                  AND i.created_at < now() - INTERVAL '5 minutes'
                THEN 'failed'
                ELSE i.status
              END AS status,
              i.started_at, i.completed_at, i.created_at,
              u.name AS uploaded_by_name, u.email AS uploaded_by_email, u.role AS uploaded_by_role
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

// Distinct list of users that the actor is allowed to filter by — drives
// the "Uploaded By" dropdown on the bulk-upload list page. Same scoping
// rules as /imports above.
router.get('/imports/uploaders', async (req, res, next) => {
  try {
    const allowed = await allowedUploaderIds(req);
    const params = [];
    let where = `WHERE u.deleted_at IS NULL`;
    if (allowed !== null) { params.push(allowed); where += ` AND u.id = ANY($${params.length}::uuid[])`; }
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT DISTINCT u.id, u.name, u.email, u.role
         FROM bulk_imports i
         JOIN users u ON u.id = i.user_id
         ${where}
        ORDER BY u.name`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/imports/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM bulk_imports WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw notFound('Import not found');
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Re-download the original uploaded spreadsheet. Returns a short-lived
// signed GCS URL so the browser can stream the file directly. Scoped to
// the same hierarchy the listing uses: super_admin gets any tenant
// upload, sales_manager only their team's, counsellor only their own.
router.get('/imports/:id/file', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT id, user_id, file_r2_key, file_name FROM bulk_imports WHERE id = $1`,
      [req.params.id],
    );
    const imp = rows[0];
    if (!imp) throw notFound('Import not found');
    if (!imp.file_r2_key) throw notFound('Original file is no longer available');

    // Same scope check as /imports list. We let the actor download iff
    // they could have seen the row in their listing.
    const allowed = await allowedUploaderIds(req);
    if (allowed !== null && !allowed.includes(imp.user_id)) {
      throw notFound('Import not found');
    }

    const { getDownloadSignedUrl } = await import('../../lib/r2.js');
    const url = await getDownloadSignedUrl({
      key: imp.file_r2_key,
      // Force the browser to save with the original file name (with a
      // sane fallback for old rows that have no file_name).
      downloadAs: imp.file_name || imp.file_r2_key.split('/').pop(),
    });
    res.json({ data: { url, file_name: imp.file_name }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/imports/:id/failures', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM bulk_import_failures WHERE import_id = $1 ORDER BY row_number LIMIT 1000`,
      [req.params.id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/imports/:id/retry-failures', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO bulk_imports (user_id, source, file_r2_key, field_mapping_json, defaults_json, total_rows, status, duplicate_handling)
       SELECT $1, 'csv', file_r2_key, field_mapping_json, defaults_json, 0, 'queued', duplicate_handling
         FROM bulk_imports WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id],
    );
    await publish(QUEUE_NAMES.BULK_IMPORT, 'retry', { tenantId: req.tenant.id, original_import_id: req.params.id, new_import_id: rows[0].id });
    res.status(202).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------- EXPORT ----------
router.post('/download', validate({ body: downloadSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO bulk_exports (user_id, filter_json, columns, cc_emails, bcc_emails, status)
       VALUES ($1,$2::jsonb,$3,$4,$5,'queued') RETURNING *`,
      [req.user.id, JSON.stringify(req.body.filter_json), req.body.columns ?? null, req.body.cc_emails ?? null, req.body.bcc_emails ?? null],
    );
    await publish(QUEUE_NAMES.BULK_EXPORT, 'run', { tenantId: req.tenant.id, export_id: rows[0].id });
    res.status(202).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/exports', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM bulk_exports WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.user.id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/exports/:id/file', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM bulk_exports WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw notFound('Export not found');
    if (rows[0].status !== 'completed' || !rows[0].file_r2_key) {
      return res.status(409).json({ error: { code: 'EXPORT_NOT_READY', message: 'Export not ready yet' } });
    }
    const { getDownloadSignedUrl } = await import('../../lib/r2.js');
    const url = await getDownloadSignedUrl({ key: rows[0].file_r2_key, downloadAs: `leads_${req.params.id}.csv` });
    res.json({ data: { url }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------- BULK OPS ----------
router.post('/status-change', validate({ body: statusChangeSchema }), async (req, res, next) => {
  try {
    const { lead_ids, stage_id, sub_stage_id } = req.body;
    const { rowCount } = await tenantQuery(
      req.tenant,
      `UPDATE leads SET stage_id = $2, sub_stage_id = $3, last_activity_at = now()
        WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [lead_ids, stage_id, sub_stage_id ?? null],
    );
    for (const id of lead_ids) {
      await tenantQuery(
        req.tenant,
        `INSERT INTO lead_activities (lead_id, user_id, type, summary) VALUES ($1,$2,'stage_changed','Bulk stage change')`,
        [id, req.user.id],
      );
    }
    res.json({ data: { updated: rowCount }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/refer', validate({ body: referSchema }), async (req, res, next) => {
  try {
    const { lead_ids, assigned_to, reason } = req.body;
    const count = await tenantTx(req.tenant, async (client) => {
      // Resolve the new owner's manager once so we can snap leads.manager_id
      // (same as bulkAssign / the single-lead reassign path).
      const { rows: mgrRow } = await client.query(`SELECT manager_id FROM users WHERE id = $1`, [assigned_to]);
      const newManagerId = mgrRow[0]?.manager_id ?? null;
      let referred = 0;
      for (const id of lead_ids) {
        // Capture the prior owner BEFORE overwriting it, so from_user_id and
        // the timeline "from → to" chain are populated.
        const { rows: leadRows } = await client.query(`SELECT assigned_to FROM leads WHERE id = $1 AND deleted_at IS NULL`, [id]);
        if (!leadRows[0]) continue; // skip missing/deleted leads
        const fromUserId = leadRows[0].assigned_to;
        if (fromUserId === assigned_to) continue; // no-op refer
        await client.query(`UPDATE lead_assignments SET is_active = false, status = 'closed' WHERE lead_id = $1 AND is_active`, [id]);
        await client.query(
          `INSERT INTO lead_assignments (lead_id, from_user_id, assigned_to, assigned_by, assignment_type, is_active, status, reason, created_at)
           VALUES ($1,$2,$3,$4,'refer',true,'open',$5, clock_timestamp())`,
          [id, fromUserId, assigned_to, req.user.id, reason ?? null],
        );
        await client.query(
          `UPDATE leads SET assigned_to = $2, manager_id = $3, last_activity_at = now() WHERE id = $1 AND deleted_at IS NULL`,
          [id, assigned_to, newManagerId],
        );
        await client.query(
          `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json, created_at)
           VALUES ($1,$2,'refer',$3,$4::jsonb, clock_timestamp())`,
          [id, req.user.id, 'Lead referred', JSON.stringify({ from: fromUserId, to: assigned_to, assigned_to, reason: reason ?? null })],
        );
        referred += 1;
      }
      return referred;
    });
    res.json({ data: { count }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
