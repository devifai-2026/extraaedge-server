// Internal callback the WhatsApp gateway POSTs to so its async Client events
// (qr / ready / disconnected / inbound message / ack) reach the right user's
// browser. The API owns the only socket.io `io` instance and the per-user room
// logic, so the gateway can't emit directly — it calls this instead.
//
// Mounted OUTSIDE the authRequired/tenantRequired chain in src/routes.js;
// the shared secret IS the credential.
import express from 'express';
import { z } from 'zod';
import { safeEqual } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { notifyUser } from '../../lib/socket.js';

const router = express.Router();

const internalAuth = (req, res, next) => {
  const got = req.headers['x-internal-secret'];
  if (!got || !safeEqual(String(got), env.WA_GATEWAY_INTERNAL_SECRET)) {
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  }
  return next();
};

const notifySchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.any()).optional().default({}),
});

router.post('/notify', internalAuth, express.json({ limit: '1mb' }), (req, res) => {
  const parsed = notifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_FAILED' } });
  const { tenantId, userId, type, payload } = parsed.data;
  notifyUser(tenantId, userId, type, payload);
  res.status(204).end();
});

export default router;
