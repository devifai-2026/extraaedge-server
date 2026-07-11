// Call recordings uploaded by the Android call-recorder app.
//
// Upload uses a presigned PUT so the audio goes phone -> GCS directly and never
// passes through this server. That sidesteps request-body size limits on
// serverless/proxy hosting (a recording can be up to 100 MB).
//
// Device flow:
//   1. POST /presign  { content_type, size_bytes, client_ref? }
//        -> { upload_url, method:'PUT', headers, r2_key }
//   2. PUT the .m4a bytes straight to upload_url (GCS).
//   3. POST /confirm  { r2_key, phone, file_name?, duration_seconds?, client_ref? }
//        -> server HEADs the object, matches phone -> lead, records the row.
//
// Two distinct actors hit this router:
//   - the DEVICE (POST /presign, POST /confirm), authenticated by the shared
//     X-Api-Key secret. No logged-in user; tenant comes from X-Tenant-Slug.
//   - CRM USERS (GET / list, GET /:id/url, POST /:id/attach, DELETE), on the
//     normal JWT + tenant middleware, gated to manager-tier roles.
//
// A no-match on confirm is still stored (match_status='unmatched') for later
// review — nothing is dropped.
import express from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { apiKeyOrAuthRequired } from '../../middleware/apiKey.js';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { getUploadSignedUrl, getDownloadSignedUrl, deleteObject, headObject, buildKey } from '../../lib/r2.js';
import { last10Digits } from '../../lib/phone.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

const router = express.Router();

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB, consistent with lead_call_recordings

// Manager-tier roles that may review / play / delete device recordings.
const MANAGER_ROLES = [
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
  SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  SYSTEM_TENANT_ROLES.SALES_MANAGER,
];

// Resolve which live lead(s) a phone number belongs to. Uses the SAME
// normalized expression as `leads_unique_phone_digits`, so the lookup is
// index-backed and consistent with dedup.
//
// Returns { status, lead_ids[], digits }:
//   - unmatched : no live lead (or < 10 digits). lead_ids = [].
//   - matched   : exactly one lead. lead_ids = [id].
//   - multi     : more than one lead — the recording is attached to ALL of
//                 them and flagged as a multi-match for review.
const matchLeads = async (tenant, phoneRaw) => {
  const digits = last10Digits(phoneRaw);
  if (digits.length < 10) return { status: 'unmatched', lead_ids: [], digits };
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM leads
      WHERE deleted_at IS NULL
        AND right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $1`,
    [digits],
  );
  const lead_ids = rows.map((r) => r.id);
  if (lead_ids.length === 0) return { status: 'unmatched', lead_ids, digits };
  if (lead_ids.length === 1) return { status: 'matched', lead_ids, digits };
  return { status: 'multi', lead_ids, digits };
};

// Resolve the counsellor who uploaded, from their own phone number. Uses the
// users phone index (users_phone_digits_idx). Returns the user id or null.
const resolveUploader = async (tenant, counsellorPhone) => {
  const digits = last10Digits(counsellorPhone);
  if (digits.length < 10) return null;
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM users
      WHERE deleted_at IS NULL
        AND right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $1
      LIMIT 1`,
    [digits],
  );
  return rows[0]?.id ?? null;
};

// ------------------------------ DEVICE: PRESIGN -----------------------------
// Returns a presigned PUT URL so the device uploads the audio straight to GCS.
const presignSchema = z.object({
  content_type: z.string().min(1).default('audio/mp4'),
  size_bytes: z.coerce.number().int().positive().max(MAX_BYTES),
});

// GCS key extension by upload content type (cosmetic — playback trusts the
// stored Content-Type — but keeps object keys honest for .mp3 app uploads).
const EXT_BY_TYPE = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
};

// A JWT caller must be a tenant user — blocks a platform-user token combined
// with an X-Tenant-Slug header from uploading into an arbitrary tenant.
const tenantUserOnly = (req, _res, next) => {
  if (req.user && !req.user.tenantId) return next(forbidden('A tenant user token is required'));
  next();
};

router.post('/presign', apiKeyOrAuthRequired, tenantRequired, tenantUserOnly, validate({ body: presignSchema }), async (req, res, next) => {
  try {
    if (!req.body.content_type.startsWith('audio/')) {
      throw validationError([{ path: 'content_type', message: 'Only audio/* uploads are allowed' }]);
    }
    const ext = EXT_BY_TYPE[req.body.content_type] ?? 'm4a';
    const key = buildKey({ tenantSlug: req.tenant.slug, purpose: 'recording', id: nanoid(20), ext });
    const signed = await getUploadSignedUrl({
      key,
      contentType: req.body.content_type,
      contentLengthRange: req.body.size_bytes,
    });
    res.json({
      data: {
        upload_url: signed.url,
        method: signed.method,      // 'PUT'
        headers: signed.headers,    // { 'Content-Type': ... } — device must echo these
        r2_key: key,
      },
      meta: { requestId: req.id },
    });
  } catch (err) { next(err); }
});

// ------------------------------ DEVICE: CONFIRM -----------------------------
// Records metadata after the device has PUT the object. Validates the object
// exists in GCS (and is audio, under the cap) before writing the row so we
// never leave a row pointing at nothing.
const confirmSchema = z.object({
  r2_key: z.string().min(1),
  phone: z.string().min(1),                 // the CALLED number (matched to a lead)
  counsellor_phone: z.string().optional(),  // the uploading counsellor's own number
  file_name: z.string().max(255).optional(),
  duration_seconds: z.coerce.number().int().nonnegative().optional(),
  client_ref: z.string().max(255).optional(),
});

router.post('/confirm', apiKeyOrAuthRequired, tenantRequired, tenantUserOnly, validate({ body: confirmSchema }), async (req, res, next) => {
  try {
    const { r2_key, phone, counsellor_phone, file_name, duration_seconds, client_ref } = req.body;
    const clientRef = client_ref || null;
    const deviceId = typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'] : null;

    // Only accept keys inside this tenant's recording namespace — a device
    // can't confirm arbitrary objects in the bucket.
    const expectedPrefix = `recording/${req.tenant.slug}/`;
    if (!r2_key.startsWith(expectedPrefix)) {
      throw validationError([{ path: 'r2_key', message: 'r2_key is not in this tenant recording namespace' }]);
    }

    // Idempotency: a retrying device may re-confirm. Return the existing row.
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

    // Authoritative validation from storage: it must exist, be audio, be small
    // enough. Trust the HEAD over anything the client claims.
    const head = await headObject(r2_key);
    if (!head) throw notFound('Upload not found in storage; the PUT may not have completed');
    if (head.ContentLength && head.ContentLength > MAX_BYTES) {
      throw validationError([{ path: 'r2_key', message: 'Recording exceeds the 100 MB limit' }]);
    }
    if (head.ContentType && !head.ContentType.startsWith('audio/')) {
      throw validationError([{ path: 'r2_key', message: `Expected an audio file, got "${head.ContentType}"` }]);
    }

    const { status, lead_ids, digits } = await matchLeads(req.tenant, phone);
    // JWT-authed app: the uploader IS the logged-in counsellor. Legacy api-key
    // devices still resolve by the counsellor's own phone number.
    const uploadedBy = req.user?.id
      ?? (counsellor_phone ? await resolveUploader(req.tenant, counsellor_phone) : null);
    const multiMatch = lead_ids.length > 1;
    // The primary lead (first match) stays on device_recordings.lead_id for
    // backward-compatible single-lead reads; the join carries the full set.
    const primaryLeadId = lead_ids[0] ?? null;

    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO device_recordings
         (lead_id, phone_raw, phone_digits, match_status, multi_match, r2_key, file_name,
          size_bytes, duration_seconds, content_type, device_id, client_ref,
          uploaded_by, counsellor_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, match_status, lead_id, multi_match`,
      [
        primaryLeadId,
        phone,
        digits || null,
        status,
        multiMatch,
        r2_key,
        file_name ?? null,
        head.ContentLength ?? null,
        duration_seconds ?? null,
        head.ContentType ?? null,
        deviceId,
        clientRef,
        uploadedBy,
        counsellor_phone ?? null,
      ],
    );
    const recordingId = rows[0].id;

    // Attach the recording to EVERY matching lead: a join row + a timeline
    // entry per lead (mirroring the manual lead-recordings shape). A multi-match
    // is flagged in metadata so the timeline/UI can indicate it went to several
    // leads with the same number.
    for (const leadId of lead_ids) {
      await tenantQuery(
        req.tenant,
        `INSERT INTO device_recording_leads (recording_id, lead_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [recordingId, leadId],
      );
      await tenantQuery(
        req.tenant,
        `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
         VALUES ($1, $2, 'call_recording_uploaded', $3, $4::jsonb)`,
        [
          leadId,
          uploadedBy,
          file_name ? `Auto-uploaded recording: ${file_name}` : 'Auto-uploaded a call recording',
          JSON.stringify({
            device_recording_id: recordingId,
            source: 'device',
            multi_match: multiMatch,
            matched_lead_count: lead_ids.length,
            file_name: file_name ?? null,
            duration_seconds: duration_seconds ?? null,
          }),
        ],
      );
    }

    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ------------------------------- CRM READ/ADMIN -----------------------------
// Counsellors can reach these routes too, but only ever see their OWN uploads
// (enforced per-query via `ownOnly`). Managers/admins see everything in scope.
router.use(authRequired, tenantRequired, requireRole(...MANAGER_ROLES, SYSTEM_TENANT_ROLES.COUNSELLOR));

// True when the actor is limited to their own uploaded recordings.
const isOwnOnly = (user) => user.role === SYSTEM_TENANT_ROLES.COUNSELLOR;

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
    if (isOwnOnly(req.user)) { params.push(req.user.id); conds.push(`dr.uploaded_by = $${params.length}`); }
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
      `SELECT r2_key, file_name, uploaded_by FROM device_recordings WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id],
    );
    if (!rows[0]) throw notFound('Recording not found');
    if (isOwnOnly(req.user) && rows[0].uploaded_by !== req.user.id) throw notFound('Recording not found');
    const url = await getDownloadSignedUrl({ key: rows[0].r2_key, expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS });
    res.json({ data: { url, file_name: rows[0].file_name }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Manually attach an unmatched recording to a lead after review.
const attachBody = z.object({ lead_id: z.string().uuid() });
router.post('/:id/attach', validate({ params: idParam, body: attachBody }), async (req, res, next) => {
  try {
    const { rows: recRows } = await tenantQuery(
      req.tenant,
      `SELECT id, file_name, duration_seconds, uploaded_by FROM device_recordings WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id],
    );
    if (!recRows[0]) throw notFound('Recording not found');
    if (isOwnOnly(req.user) && recRows[0].uploaded_by !== req.user.id) throw notFound('Recording not found');
    const { rows: leadRows } = await tenantQuery(
      req.tenant,
      `SELECT id FROM leads WHERE id = $1 AND deleted_at IS NULL`,
      [req.body.lead_id],
    );
    if (!leadRows[0]) throw notFound('Lead not found');

    // Record the attachment in the join table too (source of truth for the
    // full lead set), keeping lead_id as the primary for single-lead reads.
    await tenantQuery(
      req.tenant,
      `INSERT INTO device_recording_leads (recording_id, lead_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, req.body.lead_id],
    );
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

// Soft-delete + best-effort drop of the GCS object. All review-tab roles may
// delete; counsellors only recordings they uploaded (404 like the other
// own-only routes, so existence isn't leaked).
router.delete('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT id, r2_key, uploaded_by FROM device_recordings WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id],
    );
    if (!rows[0]) throw notFound('Recording not found');
    if (isOwnOnly(req.user) && rows[0].uploaded_by !== req.user.id) throw notFound('Recording not found');
    await tenantQuery(req.tenant, `UPDATE device_recordings SET deleted_at = now() WHERE id = $1`, [req.params.id]);
    deleteObject(rows[0].r2_key).catch(() => { /* leak the file rather than fail the delete */ });
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
