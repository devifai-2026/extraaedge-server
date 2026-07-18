// Authed WhatsApp inbox API (replaces the old Baileys /whatsapp/connection/*).
// The business number is shared per tenant (WABridge/Meta), so every request is
// scoped to the tenant's shared inbox owner (its super_admin).
import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../../middleware/auth.js';
import { tenantRequired } from '../../../middleware/tenant.js';
import { validate } from '../../../middleware/validate.js';
import { notFound, forbidden, conflict, rateLimited } from '../../../lib/errors.js';
import { env } from '../../../config/env.js';
import * as wabridge from '../../../lib/providers/whatsapp-wabridge.js';
import { resolveInboxOwner, recordOutbound, listChats, listMessages, markChatRead, normalizePhone } from './service.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// Per-user sliding-window send throttle (ban-risk mitigation).
const sendTimestamps = new Map();
const allowSend = (userId) => {
  const now = Date.now();
  const arr = (sendTimestamps.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= 20) { sendTimestamps.set(userId, arr); return false; }
  arr.push(now); sendTimestamps.set(userId, arr); return true;
};

// GET /status — the shared business number + whether sending is configured.
router.get('/status', async (req, res, next) => {
  try {
    const configured = Boolean(env.WABRIDGE_APP_KEY && env.WABRIDGE_AUTH_KEY && env.WABRIDGE_DEVICE_ID);
    res.json({ data: { configured, phone: env.WA_PHONE_NUMBER_ID ? null : null, provider: 'wabridge' }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// GET /chats — full inbox (all chats, lead-flagged).
router.get('/chats', async (req, res, next) => {
  try {
    const ownerId = await resolveInboxOwner(req.tenant);
    if (!ownerId) return res.json({ data: [], meta: { requestId: req.id } });
    const rows = await listChats(req.tenant, ownerId);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// GET /chats/:phone/messages — thread for one phone.
router.get('/chats/:phone/messages', async (req, res, next) => {
  try {
    const ownerId = await resolveInboxOwner(req.tenant);
    if (!ownerId) return res.json({ data: [], meta: { requestId: req.id } });
    const rows = await listMessages(req.tenant, ownerId, req.params.phone);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// GET /templates — WABridge approved templates for the composer.
router.get('/templates', async (req, res, next) => {
  try {
    const all = await wabridge.listTemplates().catch(() => []);
    res.json({ data: all.filter((t) => t.status === 'APPROVED'), meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// POST /chats/:phone/send — free-text (24h window) or a template.
const sendSchema = z.object({
  type: z.enum(['text', 'template']).default('text'),
  message: z.string().max(4096).optional(),
  templateId: z.string().optional(),
  variables: z.array(z.string()).optional().default([]),
}).refine((v) => (v.type === 'text' ? !!v.message?.trim() : !!v.templateId), {
  message: 'message (text) or templateId (template) is required',
});
router.post('/chats/:phone/send', validate({ body: sendSchema }), async (req, res, next) => {
  try {
    if (!allowSend(req.user.id)) throw rateLimited(60);
    const phone = normalizePhone(req.params.phone);
    if (!phone) throw forbidden('Invalid phone number');
    const ownerId = await resolveInboxOwner(req.tenant);

    let waMessageId = null;
    let body = req.body.message || '';
    try {
      if (req.body.type === 'template') {
        const out = await wabridge.sendTemplate({ to: phone, templateId: req.body.templateId, variables: req.body.variables });
        waMessageId = out.messageId;
        body = body || `[template ${req.body.templateId}]`;
      } else {
        const out = await wabridge.sendText({ to: phone, message: req.body.message });
        waMessageId = out.messageId;
      }
    } catch (sendErr) {
      // WABridge free-text fails outside the 24h window — surface a clear hint.
      if (sendErr.code === 'WABRIDGE_SEND_FAILED') {
        throw conflict(`${sendErr.message}. If it's been over 24h since the customer's last message, use an approved template.`);
      }
      throw sendErr;
    }

    await recordOutbound({ tenant: req.tenant, ownerId, phone, waMessageId, type: req.body.type, body });
    res.status(202).json({ data: { status: 'sent', wa_message_id: waMessageId }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// PATCH /chats/:phone/read — mark a conversation read.
router.patch('/chats/:phone/read', async (req, res, next) => {
  try {
    const ownerId = await resolveInboxOwner(req.tenant);
    if (ownerId) await markChatRead(req.tenant, ownerId, req.params.phone);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
