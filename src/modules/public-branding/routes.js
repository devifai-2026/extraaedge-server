// Unauthenticated public branding proxy. Mounted at /api/v1/public/branding.
//
// The tenant logo lives in a PRIVATE GCS bucket (uniform bucket-level access —
// per-object public ACLs are rejected, so a raw storage URL 403s). Instead of
// making the uploads bucket world-readable, we stream the object through the
// app using the server's own GCS credentials. The tenant slug is not a secret
// and the logo is meant to be shown to everyone (navbar on all roles + public
// receipt), so this route is intentionally outside the auth chain.
import express from 'express';
import { sysQuery } from '../../db/system.js';
import { getObjectStream } from '../../lib/r2.js';
import { logger } from '../../lib/logger.js';

const router = express.Router();

router.get('/:slug/logo', async (req, res, next) => {
  try {
    const { rows } = await sysQuery(
      `SELECT logo_r2_key FROM tenants WHERE slug = $1 AND deleted_at IS NULL LIMIT 1`,
      [req.params.slug],
    );
    const key = rows[0]?.logo_r2_key;
    if (!key) return res.status(404).end();

    const obj = await getObjectStream(key);
    if (!obj) return res.status(404).end();

    res.setHeader('Content-Type', obj.contentType);
    if (obj.contentLength != null) res.setHeader('Content-Length', obj.contentLength);
    if (obj.etag) res.setHeader('ETag', obj.etag);
    // The proxy URL is versioned (?v=<hash>) on every logo change, so this
    // immutable long-cache is safe: a new logo mints a new URL.
    res.setHeader('Cache-Control', 'public, max-age=86400');

    obj.stream.on('error', (err) => {
      logger.error({ err: err.message, slug: req.params.slug }, 'logo stream error');
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    });
    obj.stream.pipe(res);
  } catch (err) { next(err); }
});

export default router;
