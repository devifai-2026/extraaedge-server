// Unauthenticated public router. Mounted at /api/v1/public/leads in
// routes.js — explicitly OUTSIDE the auth/tenant middleware chain (same
// pattern as public-admissions), since the caller is an anonymous website
// visitor with no JWT and no tenant subdomain.
import express from 'express';
import { validate } from '../../middleware/validate.js';
import { publicLeadCreateSchema } from './schema.js';
import * as service from './service.js';

const router = express.Router();

// POST /api/v1/public/leads/free-demo
//   201 → { ok: true }
router.post(
  '/free-demo',
  validate({ body: publicLeadCreateSchema }),
  async (req, res, next) => {
    try {
      await service.submitFreeDemoLead(req.body);
      res.status(201).json({ data: { ok: true }, meta: { requestId: req.id } });
    } catch (err) { next(err); }
  },
);

export default router;
