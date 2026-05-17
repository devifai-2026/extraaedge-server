// Object storage (Google Cloud Storage).
//
// Despite the filename, this module is the storage facade for the whole app.
// It used to wrap Cloudflare R2 via the S3 SDK; it now wraps GCS via
// `@google-cloud/storage`. The exported function names + shapes are unchanged
// so callers (5 workers/modules) don't need to change.
//
// DB columns named `*_r2_key` are now opaque GCS object keys — the column
// names are kept to avoid a sweeping migration; the `r2_` prefix has no
// semantic meaning anymore.
import { Storage } from '@google-cloud/storage';
import { env } from '../config/env.js';

// Credentials resolution order:
//   1. GCS_CREDENTIALS_JSON — raw service-account JSON (used on Render/Heroku
//      where a key file can't be mounted).
//   2. GCS_KEY_FILE — path to a service-account JSON file (used locally).
//   3. Application Default Credentials — used on Cloud Run / GKE / GCE.
const gcsCredentials = env.GCS_CREDENTIALS_JSON
  ? JSON.parse(env.GCS_CREDENTIALS_JSON)
  : null;
const storage = new Storage({
  projectId: env.GCS_PROJECT_ID,
  ...(gcsCredentials
    ? { credentials: gcsCredentials }
    : env.GCS_KEY_FILE
      ? { keyFilename: env.GCS_KEY_FILE }
      : {}),
});

const bucket = () => storage.bucket(env.GCS_BUCKET);

export const getUploadSignedUrl = async ({ key, contentType, contentLengthRange, expiresIn = env.GCS_SIGNED_URL_TTL_SECONDS }) => {
  const [url] = await bucket().file(key).getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + expiresIn * 1000,
    contentType,
  });
  // Mirror the previous return shape so callers don't break.
  return {
    url,
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    key,
    expiresIn,
    contentLengthRange,
  };
};

export const getDownloadSignedUrl = async ({ key, expiresIn = env.GCS_SIGNED_URL_TTL_SECONDS, downloadAs }) => {
  const [url] = await bucket().file(key).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + expiresIn * 1000,
    ...(downloadAs ? { responseDisposition: `attachment; filename="${downloadAs}"` } : {}),
  });
  return url;
};

export const putObject = async ({ key, body, contentType, metadata }) => {
  const file = bucket().file(key);
  await file.save(body, {
    contentType,
    metadata: metadata ? { metadata } : undefined,
    resumable: false,
  });
  return { key };
};

export const deleteObject = async (key) => {
  await bucket().file(key).delete({ ignoreNotFound: true });
};

// Returns null on 404, mirroring the previous S3 behaviour. On success,
// returns an object that resembles the S3 HEAD shape just enough for
// callers (uploads/service.js reads ContentType + ContentLength).
export const headObject = async (key) => {
  const file = bucket().file(key);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [metadata] = await file.getMetadata();
  return {
    ContentType: metadata.contentType,
    ContentLength: Number(metadata.size ?? 0),
    ETag: metadata.etag,
    LastModified: metadata.updated ? new Date(metadata.updated) : undefined,
  };
};

export const buildKey = ({ tenantSlug, purpose, id, ext = 'bin' }) => {
  const date = new Date();
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${purpose}/${tenantSlug}/${yyyy}/${mm}/${id}.${ext}`;
};
