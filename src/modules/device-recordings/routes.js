// Call recordings uploaded by the Android call-recorder app.
//
// Two distinct actors hit this router:
//   - the DEVICE (POST /), authenticated by the shared X-Api-Key secret. It has
//     no logged-in user; tenant comes from the X-Tenant-Slug header.
//   - CRM USERS (GET / list, GET /:id/url, DELETE, POST /:id/attach), on the
//     normal JWT + tenant middleware, gated to manager-tier roles.
//
// The device POSTs the raw .m4a plus the call's phone number; the server
// matches the number to a lead (last-10-digits, same key as the leads unique
// index), stores the audio in GCS, and records a row. A no-match is still
// stored (match_status='unmatched') for later review — nothing is dropped.
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { apiKeyRequired } from '../../middleware/apiKey.js';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { putObject, getDownloadSignedUrl, deleteObject, buildKey } from '../../lib/r2.js';
import { last10Digits } from '../../lib/phone.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

const router = express.Router();

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB, consistent with lead_call_recordings
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

// Manager-tier roles that may review / play / delete device recordings.
const MANAGER_ROLES = [
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
  SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  SYSTEM_TENANT_ROLES.SALES_MANAGER,
];

// Resolve which live lead a phone number belongs to. Uses the SAME normalized
// expression as `leads_unique_phone_digits`, so the lookup is index-backed and
// consistent with dedup. Returns { status, lead_id }.
const matchLead = async (tenant, phoneRaw) => {
  const digits = last10Digits(phoneRaw);
  if (digits.length < 10) return { status: 'unmatched', lead_id: null, digits };
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM leads
      WHERE deleted_at IS NULL
        AND right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $1
      LIMIT 2`,
    [digits],
  );
  if (rows.length === 0) return { status: 'unmatched', lead_id: null, digits };
  if (rows.length > 1) return { status: 'ambiguous', lead_id: null, digits };
  return { status: 'matched', lead_id: rows[0].id, digits };
};

// ----------------------------- DEVICE UPLOAD --------------------------------
// multipart/form-data: file (the .m4a) + fields phone, [duration_seconds],
// [file_name], [client_ref]. Optional headers: X-Device-Id.
// apiKeyRequired first (cheap reject), then tenantRequired (X-Tenant-Slug),
// then multer parses the body.
router.post('/', apiKeyRequired, tenantRequired, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw validationError([{ path: 'file', message: 'Recording file is required' }]);
    if (req.file.mimetype && !req.file.mimetype.startsWith('audio/')) {
      throw validationError([{ path: 'file', message: `Expected an audio file, got "${req.file.mimetype}"` }]);
    }
    const phoneRaw = typeof req.body.phone === 'string' ? req.body.phone : '';
    if (!phoneRaw) throw validationError([{ path: 'phone', message: 'phone is required' }]);

    const clientRef = typeof req.body.client_ref === 'string' && req.body.client_ref ? req.body.client_ref : null;
    const deviceId = typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'] : null;

    // Idempotency: a retrying background job may re-POST the same recording.
    // If we already stored this client_ref, return it instead of duplicating.
    if (clientRef) {
      const { rows: existing } = await tenantQuery(
        req.tenant,
        `SELECT id, match_status, lead_id FROM device_recordings
          WHERE client_ref = $1 AND deleted_at IS NULL`,
        [clientRef],
      );
      if (existing[0]) {
        return res.status(200).json({ data: existing[0], meta: { requestId: req.id, idempotent: true } });
      }
    }

    const durationSeconds = req.body.duration_seconds != null && req.body.duration_seconds !== ''
      ? Number(req.body.duration_seconds)
      : null;
    const fileName = typeof req.body.file_name === 'string' && req.body.file_name ? req.body.file_name : null;

    const { status, lead_id, digits } = await matchLead(req.tenant, phoneRaw);

    // Store the audio in GCS, then the metadata row.
    const key = buildKey({ tenantSlug: req.tenant.slug, purpose: 'recording', id: nanoid(20), ext: 'm4a' });
    await putObject({ key, body: req.file.buffer, contentType: req.file.mimetype || 'audio/mp4' });

    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO device_recordings
         (lead_id, phone_raw, phone_digits, match_status, r2_key, file_name,
          size_bytes, duration_seconds, content_type, device_id, client_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, match_status, lead_id`,
      [
        lead_id,
        phoneRaw,
        digits || null,
        status,
        key,
        fileName,
        req.file.size ?? null,
        Number.isFinite(durationSeconds) ? durationSeconds : null,
        req.file.mimetype || null,
        deviceId,
        clientRef,
      ],
    );

    // On a match, drop a timeline entry so the recording surfaces on the lead,
    // mirroring the manual lead-recordings 'call_recording_uploaded' shape.
    if (lead_id) {
      await tenantQuery(
        req.tenant,
        `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
         VALUES ($1, NULL, 'call_recording_uploaded', $2, $3::jsonb)`,
        [
          lead_id,
          fileName ? `Auto-uploaded recording: ${fileName}` : 'Auto-uploaded a call recording',
          JSON.stringify({
            device_recording_id: rows[0].id,
            source: 'device',
            file_name: fileName,
            duration_seconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
          }),
        ],
      );
    }

    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ------------------------------- CRM READ/ADMIN -----------------------------
router.use(authRequired, tenantRequired, requireRole(...MANAGER_ROLES));

const listQuery = z.object({
  match_status: z.enum(['matched', 'unmatched', 'ambiguous']).optional(),
  lead_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const idParam = z.object({ id: z.string().uuid() });

// List recordings (default newest first), filterable by match_status so staff
// can work the 'unmatched' queue.
router.get('/', validate({ query: listQuery }), async (req, res, next) => {
  try {
    const conds = ['dr.deleted_at IS NULL'];
    const params = [];
    if (req.query.match_status) { params.push(req.query.match_status); conds.push(`dr.match_status = $${params.length}`); }
    if (req.query.lead_id) { params.push(req.query.lead_id); conds.push(`dr.lead_id = $${params.length}`); }
    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT dr.id, dr.lead_id, dr.phone_raw, dr.phone_digits, dr.match_status,
              dr.file_name, dr.size_bytes, dr.duration_seconds, dr.device_id,
              dr.uploaded_at, l.name AS lead_name
         FROM device_recordings dr
         LEFT JOIN leads l ON l.id = dr.lead_id
        WHERE ${conds.join(' AND ')}
        ORDER BY dr.uploaded_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Short-lived signed URL for inline playback.
router.get('/:id/url', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT r2_key, file_name FROM device_recordings WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id],
    );
    if (!rows[0]) throw notFound('Recording not found');
    const url = await getDownloadSignedUrl({ key: rows[0].r2_key, expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS });
    res.json({ data: { url, file_name: rows[0].file_name }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Manually attach an unmatched/ambiguous recording to a lead after review.
const attachBody = z.object({ lead_id: z.string().uuid() });
router.post('/:id/attach', validate({ params: idParam, body: attachBody }), async (req, res, next) => {
  try {
    const { rows: recRows } = await tenantQuery(
      req.tenant,
      `SELECT id, file_name, duration_seconds FROM device_recordings WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id],
    );
    if (!recRows[0]) throw notFound('Recording not found');
    const { rows: leadRows } = await tenantQuery(
      req.tenant,
      `SELECT id FROM leads WHERE id = $1 AND deleted_at IS NULL`,
      [req.body.lead_id],
    );
    if (!leadRows[0]) throw notFound('Lead not found');

    await tenantQuery(
      req.tenant,
      `UPDATE device_recordings SET lead_id = $2, match_status = 'matched' WHERE id = $1`,
      [req.params.id, req.body.lead_id],
    );
    await tenantQuery(
      req.tenant,
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
       VALUES ($1, $2, 'call_recording_uploaded', $3, $4::jsonb)`,
      [
        req.body.lead_id,
        req.user.id,
        recRows[0].file_name ? `Attached recording: ${recRows[0].file_name}` : 'Attached a call recording',
        JSON.stringify({
          device_recording_id: recRows[0].id,
          source: 'device',
          attached_manually: true,
          file_name: recRows[0].file_name,
          duration_seconds: recRows[0].duration_seconds,
        }),
      ],
    );
    res.json({ data: { id: recRows[0].id, lead_id: req.body.lead_id, match_status: 'matched' }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Soft-delete + best-effort drop of the GCS object. Super-admins only.
router.delete('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    if (req.user.role !== SYSTEM_TENANT_ROLES.SUPER_ADMIN) {
      throw forbidden('Only an admin can delete a recording');
    }
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT id, r2_key FROM device_recordings WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id],
    );
    if (!rows[0]) throw notFound('Recording not found');
    await tenantQuery(req.tenant, `UPDATE device_recordings SET deleted_at = now() WHERE id = $1`, [req.params.id]);
    deleteObject(rows[0].r2_key).catch(() => { /* leak the file rather than fail the delete */ });
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
