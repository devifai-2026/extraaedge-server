import { tenantQuery } from '../../db/tenant.js';
import { env } from '../../config/env.js';

export const insert = async (tenant, input) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO uploaded_files (user_id, r2_key, r2_bucket, content_type, size_bytes, checksum_sha256, purpose, ref_entity_type, ref_entity_id, visibility)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, r2_key, r2_bucket, content_type, size_bytes, checksum_sha256, purpose, ref_entity_type, ref_entity_id, visibility, uploaded_at`,
    [input.user_id ?? null, input.r2_key, env.GCS_BUCKET, input.content_type ?? null, input.size_bytes ?? null, input.checksum_sha256 ?? null, input.purpose, input.ref_entity_type ?? null, input.ref_entity_id ?? null, input.visibility ?? 'private'],
  );
  return rows[0];
};

// Idempotent variant. The public-admissions confirm endpoint may be
// retried by the FE on transient failures, so we don't want a duplicate
// row to 500 the request. ON CONFLICT (r2_key) returns the existing
// row instead — the caller treats both outcomes as success.
export const insertIfMissing = async (tenant, input) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO uploaded_files (user_id, r2_key, r2_bucket, content_type, size_bytes, purpose, ref_entity_type, ref_entity_id, visibility)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (r2_key) DO UPDATE SET r2_key = EXCLUDED.r2_key
     RETURNING id, r2_key, r2_bucket, content_type, size_bytes, purpose, visibility, uploaded_at`,
    [input.user_id ?? null, input.r2_key, env.GCS_BUCKET, input.content_type ?? null, input.size_bytes ?? null, input.purpose, input.ref_entity_type ?? null, input.ref_entity_id ?? null, input.visibility ?? 'private'],
  );
  return rows[0];
};

export const findById = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT * FROM uploaded_files WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
};

export const findByR2Key = async (tenant, key) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM uploaded_files WHERE r2_key = $1`, [key]);
  return rows[0] ?? null;
};

export const softDelete = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE uploaded_files SET deleted_at = now() WHERE id = $1`, [id]);
};
