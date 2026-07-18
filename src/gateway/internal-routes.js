// Internal REST the API calls to drive a user's WhatsApp client. Guarded by a
// shared secret (internal-auth). The gateway is the only owner of live Clients,
// so these are the only ways the rest of the system reaches them.
import express from 'express';
import { internalAuth } from './internal-auth.js';
import { startSession, getStatus, send, logout, clientCount } from './client-registry.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

router.get('/healthz', (_req, res) => res.json({ ok: true, clients: clientCount() }));

router.use(internalAuth);

router.post('/sessions/:tenantId/:userId/start', async (req, res) => {
  try {
    const out = await startSession({
      tenantId: req.params.tenantId,
      userId: req.params.userId,
      tenantSlug: req.body?.tenantSlug,
    });
    res.status(202).json(out);
  } catch (err) {
    logger.error({ err: err.message }, 'wa start failed');
    res.status(500).json({ error: { code: 'WA_START_FAILED', message: err.message } });
  }
});

router.get('/sessions/:tenantId/:userId/status', (req, res) => {
  res.json(getStatus(req.params.tenantId, req.params.userId));
});

router.post('/sessions/:tenantId/:userId/send', async (req, res) => {
  try {
    const { to, body, media } = req.body ?? {};
    // A message needs a recipient and at least text OR media (media caption may
    // be empty).
    if (!to || (!body && !media?.signedUrl)) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'to and (body or media) required' } });
    }
    const out = await send({ tenantId: req.params.tenantId, userId: req.params.userId, to, body, media });
    res.json(out);
  } catch (err) {
    if (err.code === 'NOT_CONNECTED') {
      return res.status(409).json({ error: { code: 'NOT_CONNECTED', message: 'WhatsApp not connected for this user' } });
    }
    if (err.code === 'NOT_ON_WHATSAPP') {
      return res.status(422).json({ error: { code: 'NOT_ON_WHATSAPP', message: 'This number is not on WhatsApp' } });
    }
    logger.error({ err: err.message }, 'wa send failed');
    res.status(500).json({ error: { code: 'WA_SEND_FAILED', message: err.message } });
  }
});

router.post('/sessions/:tenantId/:userId/logout', async (req, res) => {
  try {
    const out = await logout(req.params.tenantId, req.params.userId);
    res.json(out);
  } catch (err) {
    logger.error({ err: err.message }, 'wa logout failed');
    res.status(500).json({ error: { code: 'WA_LOGOUT_FAILED', message: err.message } });
  }
});

export default router;
