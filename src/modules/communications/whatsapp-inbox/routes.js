// Authed WhatsApp inbox API + per-tenant settings.
// The business number is per-tenant (WABridge), configured in Settings → WhatsApp.
import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../../middleware/auth.js';
import { tenantRequired } from '../../../middleware/tenant.js';
import { validate } from '../../../middleware/validate.js';
import { requireRole } from '../../../middleware/rbac.js';
import { forbidden, conflict, rateLimited } from '../../../lib/errors.js';
import { env } from '../../../config/env.js';
import * as wabridge from './wabridge.js';
import {
  getSettings, saveSettings, credsFor, resolveInboxOwner, recordOutbound,
  listChats, listMessages, markChatRead, normalizePhone,
} from './service.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const sendTimestamps = new Map();
const allowSend = (userId) => {
  const now = Date.now();
  const arr = (sendTimestamps.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= 20) { sendTimestamps.set(userId, arr); return false; }
  arr.push(now); sendTimestamps.set(userId, arr); return true;
};

// The public webhook URL a tenant registers in WABridge (slug + token).
const webhookUrl = (req, token) =>
  `${env.BASE_URL}/api/v1/whatsapp/webhook/${req.tenant.slug}${token ? `?token=${token}` : ''}`;

// ── Settings (super_admin only) ──────────────────────────────────
router.get('/settings', requireRole('super_admin'), async (req, res, next) => {
  try {
    const s = await getSettings(req.tenant);
    res.json({
      data: {
        enabled: s.enabled,
        app_key: s.appKey,
        auth_key: s.authKey ? '••••••••' : '',      // never echo the secret back in full
        device_id: s.deviceId,
        business_phone: s.businessPhone,
        webhook_url: s.webhookToken ? webhookUrl(req, s.webhookToken) : null,
        configured: !!(s.appKey && s.authKey && s.deviceId),
      },
      meta: { requestId: req.id },
    });
  } catch (err) { next(err); }
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  app_key: z.string().max(200).optional(),
  auth_key: z.string().max(400).optional(),   // '••••••••' left unchanged → ignored below
  device_id: z.string().max(200).optional(),
  business_phone: z.string().max(20).optional(),
});
router.put('/settings', requireRole('super_admin'), validate({ body: settingsSchema }), async (req, res, next) => {
  try {
    const b = req.body;
    const saved = await saveSettings(req.tenant, {
      enabled: b.enabled,
      appKey: b.app_key,
      // Only overwrite the auth key when a real (non-masked) value is provided.
      authKey: b.auth_key && b.auth_key !== '••••••••' ? b.auth_key : undefined,
      deviceId: b.device_id,
      businessPhone: b.business_phone,
    });
    res.json({ data: { webhook_url: webhookUrl(req, saved.webhookToken), configured: !!(saved.appKey && saved.authKey && saved.deviceId) }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ── Inbox ────────────────────────────────────────────────────────
router.get('/status', async (req, res, next) => {
  try {
    const s = await getSettings(req.tenant);
    res.json({ data: { configured: !!(s.appKey && s.authKey && s.deviceId && s.enabled), phone: s.businessPhone || null }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/chats', async (req, res, next) => {
  try {
    const ownerId = await resolveInboxOwner(req.tenant);
    if (!ownerId) return res.json({ data: [], meta: { requestId: req.id } });
    res.json({ data: await listChats(req.tenant, ownerId), meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/chats/:phone/messages', async (req, res, next) => {
  try {
    const ownerId = await resolveInboxOwner(req.tenant);
    if (!ownerId) return res.json({ data: [], meta: { requestId: req.id } });
    res.json({ data: await listMessages(req.tenant, ownerId, req.params.phone), meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/templates', async (req, res, next) => {
  try {
    const s = await getSettings(req.tenant);
    const all = await wabridge.listTemplates(credsFor(s)).catch(() => []);
    res.json({ data: all.filter((t) => t.status === 'APPROVED'), meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

const sendSchema = z.object({
  type: z.enum(['text', 'template']).default('text'),
  message: z.string().max(4096).optional(),
  templateId: z.string().optional(),
  variables: z.array(z.string()).optional().default([]),
}).refine((v) => (v.type === 'text' ? !!v.message?.trim() : !!v.templateId), { message: 'message or templateId required' });

router.post('/chats/:phone/send', validate({ body: sendSchema }), async (req, res, next) => {
  try {
    if (!allowSend(req.user.id)) throw rateLimited(60);
    const phone = normalizePhone(req.params.phone);
    if (!phone) throw forbidden('Invalid phone number');
    const s = await getSettings(req.tenant);
    if (!(s.appKey && s.authKey && s.deviceId)) throw conflict('WhatsApp is not configured. Add WABridge keys in Settings → WhatsApp.');
    const creds = credsFor(s);
    const ownerId = await resolveInboxOwner(req.tenant);

    let waMessageId = null;
    let body = req.body.message || '';
    try {
      if (req.body.type === 'template') {
        const out = await wabridge.sendTemplate(creds, { to: phone, templateId: req.body.templateId, variables: req.body.variables });
        waMessageId = out.messageId; body = body || `[template ${req.body.templateId}]`;
      } else {
        const out = await wabridge.sendText(creds, { to: phone, message: req.body.message });
        waMessageId = out.messageId;
      }
    } catch (sendErr) {
      if (sendErr.code === 'WABRIDGE_SEND_FAILED') {
        throw conflict(`${sendErr.message}. If it's been over 24h since the customer's last message, use an approved template.`);
      }
      throw sendErr;
    }

    await recordOutbound({ tenant: req.tenant, ownerId, phone, waMessageId, type: req.body.type, body });
    res.status(202).json({ data: { status: 'sent', wa_message_id: waMessageId }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.patch('/chats/:phone/read', async (req, res, next) => {
  try {
    const ownerId = await resolveInboxOwner(req.tenant);
    if (ownerId) await markChatRead(req.tenant, ownerId, req.params.phone);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
