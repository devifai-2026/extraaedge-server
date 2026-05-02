import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

// Cloudflare R2 is S3-compatible.
const client = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

export const getUploadSignedUrl = async ({ key, contentType, contentLengthRange, expiresIn = env.R2_SIGNED_URL_TTL_SECONDS }) => {
  const cmd = new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const url = await getSignedUrl(client, cmd, { expiresIn });
  return {
    url,
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    key,
    expiresIn,
    contentLengthRange,
  };
};

export const getDownloadSignedUrl = async ({ key, expiresIn = env.R2_SIGNED_URL_TTL_SECONDS, downloadAs }) => {
  const cmd = new GetObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    ResponseContentDisposition: downloadAs ? `attachment; filename="${downloadAs}"` : undefined,
  });
  return getSignedUrl(client, cmd, { expiresIn });
};

export const putObject = async ({ key, body, contentType, metadata }) => {
  const cmd = new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: metadata,
  });
  return client.send(cmd);
};

export const deleteObject = async (key) => {
  const cmd = new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key });
  return client.send(cmd);
};

export const headObject = async (key) => {
  try {
    return await client.send(new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
};

export const buildKey = ({ tenantSlug, purpose, id, ext = 'bin' }) => {
  const date = new Date();
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${purpose}/${tenantSlug}/${yyyy}/${mm}/${id}.${ext}`;
};
