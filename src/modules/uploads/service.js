import { nanoid } from 'nanoid';
import * as repo from './repo.js';
import { getUploadSignedUrl, getDownloadSignedUrl, deleteObject, headObject, buildKey } from '../../lib/r2.js';
import { env } from '../../config/env.js';
import { notFound, forbidden } from '../../lib/errors.js';

const extensionFrom = (contentType, filename) => {
  if (filename && filename.includes('.')) return filename.split('.').pop().toLowerCase();
  const map = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg',
    'application/pdf': 'pdf', 'text/csv': 'csv', 'application/json': 'json',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
  };
  return map[contentType] ?? 'bin';
};

export const presignUpload = async (tenant, user, input) => {
  const ext = extensionFrom(input.content_type, input.filename);
  const key = buildKey({ tenantSlug: tenant.slug, purpose: input.purpose, id: nanoid(24), ext });
  const signed = await getUploadSignedUrl({
    key,
    contentType: input.content_type,
    contentLengthRange: input.size_bytes,
  });
  return {
    upload_url: signed.url,
    method: signed.method,
    headers: signed.headers,
    r2_key: key,
    expires_at: new Date(Date.now() + signed.expiresIn * 1000).toISOString(),
  };
};

export const confirmUpload = async (tenant, user, input) => {
  // Verify the object actually exists in R2 before recording it.
  const head = await headObject(input.r2_key);
  if (!head) throw notFound('Upload not found in R2; upload did not complete');
  return repo.insert(tenant, {
    user_id: user.id,
    r2_key: input.r2_key,
    content_type: head.ContentType,
    size_bytes: input.size_bytes ?? head.ContentLength,
    checksum_sha256: input.checksum_sha256,
    purpose: input.purpose,
    ref_entity_type: input.ref_entity_type,
    ref_entity_id: input.ref_entity_id,
    visibility: input.visibility,
  });
};

export const getSignedDownload = async (tenant, user, id) => {
  const row = await repo.findById(tenant, id);
  if (!row) throw notFound('Upload not found');
  if (row.visibility === 'private' && row.user_id && row.user_id !== user.id) {
    // Allow tenant users with manager+ role to access others' private uploads if desired — keep strict here.
    // (Override at module boundary if a manager endpoint needs this.)
    if (user.role !== 'super_admin' && user.role !== 'sales_manager') throw forbidden('Not your upload');
  }
  const url = await getDownloadSignedUrl({ key: row.r2_key, expiresIn: env.R2_SIGNED_URL_TTL_SECONDS });
  return { url, expires_in: env.R2_SIGNED_URL_TTL_SECONDS, uploaded_file: row };
};

export const deleteUpload = async (tenant, user, id) => {
  const row = await repo.findById(tenant, id);
  if (!row) throw notFound('Upload not found');
  if (row.user_id && row.user_id !== user.id && user.role !== 'super_admin' && user.role !== 'sales_manager') {
    throw forbidden('Not your upload');
  }
  await deleteObject(row.r2_key).catch(() => {});
  await repo.softDelete(tenant, id);
};
