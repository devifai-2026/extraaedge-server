// Unauthenticated public router. Mounted at /api/v1/public/admissions in
// routes.js — explicitly OUTSIDE the auth/tenant middleware chain. The
// token in the URL IS the credential.
import express from 'express';
import { validate } from '../../middleware/validate.js';
import {
  publicSubmitSchema, tokenParam,
  publicPresignSchema, publicConfirmSchema, publicSignedUrlQuery,
} from './schema.js';
import * as service from './service.js';

const router = express.Router();

// GET /api/v1/public/admissions/:token
//   200 → { lead, programs, centers, tenant, expires_at }
//   404 → token not found
//   410 → expired or already used
router.get('/:token', validate({ params: tokenParam }), async (req, res, next) => {
  try {
    const data = await service.prefillFromToken(req.params.token);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// POST /api/v1/public/admissions/:token/submit
//   201 → { admission_id }
//   404 → token not found
//   410 → expired or already used
//   409 → an admission already exists for this lead
router.post(
  '/:token/submit',
  validate({ params: tokenParam, body: publicSubmitSchema }),
  async (req, res, next) => {
    try {
      const data = await service.submitFromToken(req.params.token, req.body);
      res.status(201).json({ data, meta: { requestId: req.id } });
    } catch (err) { next(err); }
  },
);

// Token-scoped photo upload pipeline. The student PUTs to the signed
// URL directly, then confirms so we record the GCS key on the form.
router.post(
  '/:token/upload-presign',
  validate({ params: tokenParam, body: publicPresignSchema }),
  async (req, res, next) => {
    try {
      const data = await service.presignPublicPhoto(req.params.token, req.body);
      res.json({ data, meta: { requestId: req.id } });
    } catch (err) { next(err); }
  },
);

router.post(
  '/:token/upload-confirm',
  validate({ params: tokenParam, body: publicConfirmSchema }),
  async (req, res, next) => {
    try {
      const data = await service.confirmPublicPhoto(req.params.token, req.body);
      res.json({ data, meta: { requestId: req.id } });
    } catch (err) { next(err); }
  },
);

// Signed GET URL for the thumbnail preview after upload.
router.get(
  '/:token/signed-url',
  validate({ params: tokenParam, query: publicSignedUrlQuery }),
  async (req, res, next) => {
    try {
      const data = await service.signedPublicPhotoUrl(req.params.token, req.query.r2_key);
      res.json({ data, meta: { requestId: req.id } });
    } catch (err) { next(err); }
  },
);

export default router;
