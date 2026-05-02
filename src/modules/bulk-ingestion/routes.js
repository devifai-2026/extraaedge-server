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

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const router = express.Router();
// All authenticated tenant users (including counsellors) may upload leads.
router.use(authRequired, tenantRequired, requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER, SYSTEM_TENANT_ROLES.COUNSELLOR));

// Serve the canonical CSV template. Institutes download this and fill it in.
router.get('/template', async (_req, res, next) => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const csvPath = path.resolve(here, '../../../docs/bulk-lead-template.csv');
    const body = await readFile(csvPath, 'utf8');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bulk-lead-template.csv"');
    res.send(body);
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
        { name: 'source', fields: ['channel', 'source', 'campaign', 'medium'] },
        { name: 'ownership', fields: ['assigned_to_email'] },
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
  duplicate_handling: z.enum(['skip', 'update_existing', 'create_new']).default('skip'),
  send_welcome_email: z.boolean().default(false),
  send_welcome_sms: z.boolean().default(false),
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
      `INSERT INTO bulk_imports (user_id, preview_id, source, file_r2_key, field_mapping_json, defaults_json, total_rows, duplicate_handling, status, send_welcome_email, send_welcome_sms)
       VALUES ($1,$2,'csv',$3,$4::jsonb,$5::jsonb,$6,$7,'queued',$8,$9) RETURNING *`,
      [req.user.id, preview.id, preview.file_r2_key, preview.field_mapping_json, preview.defaults_json, preview.total_rows, req.body.duplicate_handling, req.body.send_welcome_email, req.body.send_welcome_sms],
    );
    await publish(QUEUE_NAMES.BULK_IMPORT, 'commit', { tenantId: req.tenant.id, import_id: rows[0].id });
    res.status(202).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/imports', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM bulk_imports WHERE user_id = $1 OR $2 ORDER BY created_at DESC LIMIT 200`,
      [req.user.id, req.user.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN],
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
    for (const id of lead_ids) {
      await tenantQuery(
        req.tenant,
        `UPDATE lead_assignments SET is_active = false WHERE lead_id = $1 AND is_active`,
        [id],
      );
      await tenantQuery(
        req.tenant,
        `INSERT INTO lead_assignments (lead_id, assigned_to, assigned_by, assignment_type, is_active, status, reason)
         VALUES ($1,$2,$3,'refer',true,'open',$4)`,
        [id, assigned_to, req.user.id, reason ?? null],
      );
      await tenantQuery(
        req.tenant,
        `UPDATE leads SET assigned_to = $2 WHERE id = $1 AND deleted_at IS NULL`,
        [id, assigned_to],
      );
    }
    res.json({ data: { count: lead_ids.length }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
