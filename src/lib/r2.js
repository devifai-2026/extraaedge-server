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

const gcsCredentials = {
  type: 'service_account',
  project_id: 'extraedge',
  private_key_id: '2f483ad2f8c9f6f760731a0dba11b54f382041c3',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQD4npeWMjo1nSFg\nb8COtswIOm9Q1g/VJ0XppY95QsDmXLoIUImzQNO5TV7F+0R0/YAX8Au4qB8p8t0e\nZKJtPhIk2cIdW20YZ/w6WQ/ukpcE1yjG0xdgHqG4ipodE6PF2vTY2UynbeV5sOr9\n2ZBCeZEU7ZmXgwWzs4fxOI4XgCwqi9zc9rlbra7n52mFFKB6kzPopovx15VsF2rO\nAuQiYdruBvPALzgciynvHukXwDw3C4oxrmXfsucxZqnBcPCcVl9t6FZ9Pt7OP8m6\nQVrAKWungRbZGqRtKAy/nPQfzogRJzs2tXJRaVmrY/Z3dDbzG4v90lwINgMfjr8/\nYO24F4wDAgMBAAECggEAae+BneEXBoNGloXnoafoNlVX2zTrGCMc2hrOkJfOBBpc\ntnBCzFuCG8II8QlIuSTPMOP6yprwdHpkl6+/uhapuoQC/2lWigC868vJSxmxOcHI\nQTfvDOjgdfaxBlS5AvRyQfgNfoYIMpsc9j9/BaQxGp7HRFTy2AhWk4VKnl7h8tpA\npdYGe4qCTMTGGeIglDXrbWj1mppGia4KP3VJEePJu3Nq4Af+EiNXzDkqUs8OII6K\n/omMctMNuHax75eoeTH0QiBgr6lcZogMOVhLK52G5OM6tDBabQqJg025VYNsx0sn\nZfM5pGD8JX9E9fFBTZMsTxmdJ5w8naLvPk0OJHKVuQKBgQD/X3ulJ518m/fFdkOQ\nKdO1bWgxVqFgTmme0ZmeQBwrMR+SwhHLESWG5dG2QIhggvDBJXFYAZyH3nTKQ3i8\nT30bZhsFyaBBBqGd3s3A78A38ab2I9jIy4YMlf4+V4RchQf8c+KE9rI5ZLc8mHAN\ngL8P1QVAhal/37WHl2Ic2MBPBwKBgQD5Ot07QrHNE6ERclOq6VzPaIeCf2rRZwNN\nTAQiHGwjWJCrpd7iisPn7Jue7LsLYwWag2aVKnvn1yKVwYTN5ssK/XbqAgct5HkG\n9sZeYfJHE8oWqnd49XpyhLIvW8JJvPwntpRovgB4QFYSTE7kdE8/kccnzSirF5bf\nursXmCrgJQKBgFyBfgypeQb2iJ5i5L6IKESESUX2F6cHQINjcb49gvayaLmEy2U/\n5NQk0/6tCbnMNOICajhy/PzKvIu4PTgZozwVlJxYGVD00f6aAvZs4rhhNRXcjl7O\nOtS8UMjMcwoAto/geqGnq4/Wx/mPTqfVh2B4zdo9kNTdeKiRUd0ZNzBpAoGBAODr\n/8ZAfYfPZDgDjoCbFFhWRJ0/8p3CstcqeDx0nB8WCZHvIwQeKYkAHr3BdVhkaCU2\n2vhZm/LyU9MFD55m3+0uLAgqBmKjY5omUYXSLT16HZJxC1tNZtE88jYNQH0dog8R\nFkSk3HWp0kO3PCeu0+pR3IMOAtrNciq9MaWsfV1FAoGBAPdd61/QoqXF4PWlyTq3\nhFcYFyz72jMuKMd7R7EXX9hmWJO+5wcmW6kWq4aR9n6rD4CTz9w0Ki6yQvmKJ27K\n/gBPAlsjrQBYHf28iAi9BksiSSMXs1MgOwbQ2O7bFbA76hovWgHlOVVe5fkk89Li\nG+3ftgJvZZcnX/MmmLz68cRv\n-----END PRIVATE KEY-----\n',
  client_email: 'extraaedge-server-gcs@extraedge.iam.gserviceaccount.com',
  client_id: '110962332141183550482',
};
const storage = new Storage({
  projectId: gcsCredentials.project_id,
  credentials: gcsCredentials,
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

// Stable, non-expiring public URL for an object. Only meaningful for objects
// that are actually readable without auth (see makePublic). Used for the
// tenant logo, which the navbar (all roles) + the public receipt render
// directly as <img src>, so a short-lived signed URL won't do.
export const publicUrl = (key) => `https://storage.googleapis.com/${env.GCS_BUCKET}/${key}`;

// Grant public read on a single object + return its public URL. Best-effort:
// on a uniform-bucket-level-access bucket, per-object ACLs are rejected — in
// that case the bucket's IAM must already allow public reads, and the URL
// still works. We swallow the ACL error so callers get the URL regardless.
export const makePublic = async (key) => {
  try {
    await bucket().file(key).makePublic();
  } catch {
    // Uniform bucket-level access (or already public) — ignore; the public
    // URL is valid as long as the bucket policy permits anonymous reads.
  }
  return publicUrl(key);
};

// Stream a (possibly private) object straight through the app, using the
// server's own GCS credentials — no signed URL, no public ACL, no TTL. Used by
// the branding proxy to serve the tenant logo to every visitor (navbar on all
// roles + public receipt) even though the uploads bucket is private. Returns
// `{ stream, contentType, contentLength, etag }`, or null if the key is missing.
export const getObjectStream = async (key) => {
  const file = bucket().file(key);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [metadata] = await file.getMetadata();
  return {
    stream: file.createReadStream(),
    contentType: metadata.contentType || 'application/octet-stream',
    contentLength: metadata.size != null ? Number(metadata.size) : undefined,
    etag: metadata.etag,
  };
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
