// Manual call-recording attachments on a lead.
//
// All endpoints sit under /leads/:lead_id/recordings and gate on the same
// access rule the leads module uses (`getLead` throws 403/404 for actors
// outside scope), so we don't need to duplicate role logic here.
import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { getLead } from '../leads/service.js';
import { getDownloadSignedUrl, headObject, deleteObject } from '../../lib/r2.js';
import { env } from '../../config/env.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

const router = express.Router({ mergeParams: true });
router.use(authRequired, tenantRequired);

const leadIdParam = z.object({ lead_id: z.string().uuid() });
const recordingIdParams = z.object({ lead_id: z.string().uuid(), id: z.string().uuid() });

const createSchema = z.object({
  // The presigned PUT already happened on the FE before calling us; we
  // just record the metadata.
  r2_key: z.string().min(1),
  file_name: z.string().max(255).optional(),
  size_bytes: z.coerce.number().int().positive().max(100 * 1024 * 1024).optional(),
  duration_seconds: z.coerce.number().int().nonnegative().optional(),
  notes: z.string().max(2000).optional(),
});

// Capture the lead's CURRENT stage at the moment of attach. Snapshotting
// here means the recording stays tagged with that stage even if the lead
// later moves through other stages.
const snapshotStage = async (tenant, lead_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT stage_id, sub_stage_id FROM leads WHERE id = $1 AND deleted_at IS NULL`,
    [lead_id],
  );
  return rows[0] ?? { stage_id: null, sub_stage_id: null };
};

// List recordings for a lead. Returns raw metadata; the FE asks for a
// signed URL on demand when the user clicks play, so we don't burn signing
// cycles on rows that may never get played.
router.get('/', validate({ params: leadIdParam }), async (req, res, next) => {
  try {
    await getLead(req.tenant, req.user, req.params.lead_id); // access gate
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT r.id, r.lead_id, r.stage_id, r.sub_stage_id,
              r.file_name, r.size_bytes, r.duration_seconds, r.notes,
              r.uploaded_by, r.uploaded_at,
              s.name AS stage_name,
              ss.name AS sub_stage_name,
              u.name AS uploaded_by_name, u.email AS uploaded_by_email, u.role AS uploaded_by_role
         FROM lead_call_recordings r
         LEFT JOIN lead_stages s ON s.id = r.stage_id
         LEFT JOIN lead_sub_stages ss ON ss.id = r.sub_stage_id
         LEFT JOIN users u ON u.id = r.uploaded_by
        WHERE r.lead_id = $1 AND r.deleted_at IS NULL
        ORDER BY r.uploaded_at DESC`,
      [req.params.lead_id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Attach a previously-uploaded mp3 to the lead. Validates the object
// actually exists in storage before recording metadata so we don't leave
// orphan rows pointing at nothing.
router.post('/', validate({ params: leadIdParam, body: createSchema }), async (req, res, next) => {
  try {
    await getLead(req.tenant, req.user, req.params.lead_id);

    // Server-side enforcement: object must exist in GCS, must look like
    // an audio file based on Content-Type the storage wrote on PUT, and
    // must be under the 100 MB cap. We trust the file_name we get because
    // it's stored as text and not interpreted, but we still validate
    // dimensions from the storage HEAD which is authoritative.
    const head = await headObject(req.body.r2_key);
    if (!head) throw notFound('Upload not found in storage; PUT may not have completed');
    if (head.ContentLength && head.ContentLength > 100 * 1024 * 1024) {
      throw validationError([{ path: 'r2_key', message: 'Recording exceeds the 100 MB limit' }]);
    }
    if (head.ContentType && !head.ContentType.startsWith('audio/')) {
      // We only show .mp3 in the picker but this catches manual API misuse.
      throw validationError([{ path: 'r2_key', message: `Expected an audio file, got "${head.ContentType}"` }]);
    }

    const stage = await snapshotStage(req.tenant, req.params.lead_id);
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO lead_call_recordings
         (lead_id, stage_id, sub_stage_id, r2_key, file_name, size_bytes, duration_seconds, notes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, uploaded_at`,
      [
        req.params.lead_id,
        stage.stage_id,
        stage.sub_stage_id,
        req.body.r2_key,
        req.body.file_name ?? null,
        req.body.size_bytes ?? head.ContentLength ?? null,
        req.body.duration_seconds ?? null,
        req.body.notes ?? null,
        req.user.id,
      ],
    );
    const recording_id = rows[0].id;

    // Drop a row in lead_activities so the unified timeline picks it up.
    // metadata_json carries the recording id + stage snapshot — the
    // timeline modal can use that to fetch a play URL on demand.
    await tenantQuery(
      req.tenant,
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
       VALUES ($1, $2, 'call_recording_uploaded', $3, $4::jsonb)`,
      [
        req.params.lead_id,
        req.user.id,
        req.body.file_name ? `Uploaded recording: ${req.body.file_name}` : 'Uploaded a call recording',
        JSON.stringify({
          recording_id,
          stage_id: stage.stage_id,
          sub_stage_id: stage.sub_stage_id,
          file_name: req.body.file_name ?? null,
          duration_seconds: req.body.duration_seconds ?? null,
        }),
      ],
    );

    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Short-lived signed URL for playback. Issued on demand so the URL doesn't
// leak via the listing response (and so we don't sign URLs the user never
// hits play on).
router.get('/:id/url', validate({ params: recordingIdParams }), async (req, res, next) => {
  try {
    await getLead(req.tenant, req.user, req.params.lead_id);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT r2_key, file_name FROM lead_call_recordings
        WHERE id = $1 AND lead_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.params.lead_id],
    );
    if (!rows[0]) throw notFound('Recording not found');
    const url = await getDownloadSignedUrl({
      key: rows[0].r2_key,
      expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS,
      // No `downloadAs` — we want the audio to stream inline, not download.
    });
    res.json({ data: { url, file_name: rows[0].file_name }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Soft-delete. Only the uploader or a super_admin can remove. We don't
// drop the GCS object on soft-delete (audit trail); a separate sweep
// could hard-delete after N days if needed.
router.delete('/:id', validate({ params: recordingIdParams }), async (req, res, next) => {
  try {
    await getLead(req.tenant, req.user, req.params.lead_id);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT id, uploaded_by, r2_key FROM lead_call_recordings
        WHERE id = $1 AND lead_id = $2 AND deleted_at IS NULL`,
      [req.params.id, req.params.lead_id],
    );
    const rec = rows[0];
    if (!rec) throw notFound('Recording not found');
    const isOwner = rec.uploaded_by === req.user.id;
    const isAdmin = req.user.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN;
    if (!isOwner && !isAdmin) throw forbidden('Only the uploader or an admin can delete this recording');
    await tenantQuery(req.tenant, `UPDATE lead_call_recordings SET deleted_at = now() WHERE id = $1`, [req.params.id]);
    // Best-effort: also delete the underlying GCS object. Soft-deleted
    // metadata stays in the DB for audit; the file itself doesn't need to.
    deleteObject(rec.r2_key).catch(() => { /* leak the file rather than fail the delete */ });
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
