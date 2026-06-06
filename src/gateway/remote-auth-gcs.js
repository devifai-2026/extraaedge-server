// whatsapp-web.js RemoteAuth store backed by Google Cloud Storage.
//
// RemoteAuth zips a Client's session folder to `${dataPath}/${session}.zip`
// and then hands us the session name (and, on extract, the local path to
// restore into). We persist that zip blob to GCS using the same storage facade
// (src/lib/r2.js) that the bulk Excel/CSV import uses, so a user's linked
// WhatsApp survives gateway restarts and works across instances.
//
// Store contract (called by node_modules/whatsapp-web.js RemoteAuth):
//   sessionExists({ session })          -> boolean
//   save({ session })                   -> reads `${dataPath}/${session}.zip`, uploads
//   extract({ session, path })          -> downloads blob, writes to `path`
//   delete({ session })                 -> removes the blob
//
// `session` is `RemoteAuth-<clientId>` where clientId = `${tenantId}__${userId}`.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { putObject, getDownloadSignedUrl, deleteObject, headObject, buildKey } from '../lib/r2.js';
import { logger } from '../lib/logger.js';

export class GcsStore {
  // `dataPath` must match the RemoteAuth dataPath so we can find the zip it wrote.
  // `tenantSlug` namespaces the GCS key the same way every other upload is keyed.
  constructor({ dataPath, tenantSlug }) {
    this.dataPath = dataPath;
    this.tenantSlug = tenantSlug;
  }

  // Map a RemoteAuth session name to a stable GCS object key. The session name
  // already encodes tenant+user (RemoteAuth-<tenantId>__<userId>), so use it as
  // the id and keep everything under one purpose folder.
  keyFor(session) {
    return buildKey({
      tenantSlug: this.tenantSlug,
      purpose: 'whatsapp-sessions',
      id: session,
      ext: 'zip',
    });
  }

  async sessionExists({ session }) {
    try {
      return (await headObject(this.keyFor(session))) !== null;
    } catch (err) {
      logger.warn({ session, err: err.message }, 'wa-store sessionExists failed');
      return false;
    }
  }

  async save({ session }) {
    const zipPath = path.join(this.dataPath, `${session}.zip`);
    const body = await fsp.readFile(zipPath);
    await putObject({ key: this.keyFor(session), body, contentType: 'application/zip' });
    logger.debug({ session, bytes: body.length }, 'wa-store session saved to GCS');
  }

  async extract({ session, path: destPath }) {
    const url = await getDownloadSignedUrl({ key: this.keyFor(session), expiresIn: 120 });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`wa-store extract download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.writeFile(destPath, buf);
    logger.debug({ session, bytes: buf.length }, 'wa-store session extracted from GCS');
  }

  async delete({ session }) {
    await deleteObject(this.keyFor(session));
    logger.debug({ session }, 'wa-store session deleted from GCS');
  }
}

// Convenience for callers that want the key without a store instance (e.g. to
// stamp user_whatsapp_sessions.session_gcs_key).
export const sessionGcsKey = (tenantSlug, session) =>
  buildKey({ tenantSlug, purpose: 'whatsapp-sessions', id: session, ext: 'zip' });
