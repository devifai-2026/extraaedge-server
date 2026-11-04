// Unauthenticated public router. Mounted at /api/v1/public/leads in
// routes.js — explicitly OUTSIDE the auth/tenant middleware chain (same
// pattern as public-admissions), since the caller is an anonymous website
// visitor with no JWT and no tenant subdomain.
import express from 'express';
import { validate } from '../../middleware/validate.js';
import { publicLeadCreateSchema, sheetLeadSchema } from './schema.js';
import { safeEqual } from '../../lib/crypto.js';
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

// POST /api/v1/public/leads/si-hr
//   201 → { ok: true }
// speedupinfotech.com/hr form. Writes to the SI HR tenant only.
router.post(
  '/si-hr',
  validate({ body: publicLeadCreateSchema }),
  async (req, res, next) => {
    try {
      await service.submitHrLead(req.body);
      res.status(201).json({ data: { ok: true }, meta: { requestId: req.id } });
    } catch (err) { next(err); }
  },
);

// POST /api/v1/public/leads/si-hr/sheet
//   header X-Sheet-Secret: <SI_HR_SHEET_SECRET>
//   body   { row: { <sheet header>: <cell>, ... } }
//   200 → { status: 'created' | 'duplicate' | 'invalid', lead_id?, reason? }
// Called by the SI HR Meta Lead Ads Google Sheet's Apps Script. Unlike the
// website form, this carries email/city/campaign/answers, so it's gated by a
// shared secret rather than left open.
router.post(
  '/si-hr/sheet',
  (req, res, next) => {
    const secret = process.env.SI_HR_SHEET_SECRET;
    const given = req.get('x-sheet-secret') || '';
    if (!secret) return res.status(503).json({ error: 'sheet sync not configured' });
    if (!safeEqual(given, secret)) return res.status(401).json({ error: 'bad secret' });
    next();
  },
  validate({ body: sheetLeadSchema }),
  async (req, res, next) => {
    try {
      const result = await service.submitHrSheetLead(req.body.row);
      res.status(200).json({ data: result, meta: { requestId: req.id } });
    } catch (err) { next(err); }
  },
);

export default router;
