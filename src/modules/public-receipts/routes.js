// Unauthenticated public router for shareable receipt URLs.
// Mounted at /api/v1/public/receipts. Trust model: the share_token is
// the credential — it's a 32-byte random string minted at receipt-create
// time and stored on the row. Whoever holds the URL can view the
// receipt; that's by design (the accounts team shares it with the
// student / parent).
//
// We expose only the minimum fields needed to render a printable
// receipt: receipt details + student name + course name + tenant
// branding. NEVER add internal admission state, lead activity, owner
// info, etc.
import express from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import * as service from './service.js';

const router = express.Router();

const tokenParam = z.object({ token: z.string().min(20).max(128) });

router.get('/:token', validate({ params: tokenParam }), async (req, res, next) => {
  try {
    const data = await service.lookupByToken(req.params.token);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
