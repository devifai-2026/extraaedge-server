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
  listChats, listMessages, markChatRead, resolveChatForActor, normalizePhone,
  listTemplates, addTemplate, deleteTemplate, unreadSummary, renderTemplateBody,
  linkChatToLead, deleteChat,
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

// The public webhook URL a tenant registers in WABridge (routed by slug).
const webhookUrl = (req) =>
  `${env.BASE_URL}/api/v1/whatsapp/webhook/${req.tenant.slug}`;

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
        template_otp: s.templateOtp,
        webhook_url: webhookUrl(req),
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
  template_otp: z.string().max(64).optional(),
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
      templateOtp: b.template_otp,
    });
    res.json({ data: { webhook_url: webhookUrl(req), configured: !!(saved.appKey && saved.authKey && saved.deviceId) }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ── Inbox ────────────────────────────────────────────────────────
router.get('/status', async (req, res, next) => {
  try {
    const s = await getSettings(req.tenant);
    res.json({ data: { configured: !!(s.appKey && s.authKey && s.deviceId && s.enabled), phone: s.businessPhone || null }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Chats + messages are scoped by the caller's role (via the linked lead's
// owner): counsellor→own, sales_manager→team, branch_manager→branch,
// super_admin/account_manager→all.
router.get('/chats', async (req, res, next) => {
  try {
    res.json({ data: await listChats(req.tenant, req.user), meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/chats/:phone/messages', async (req, res, next) => {
  try {
    res.json({ data: await listMessages(req.tenant, req.user, req.params.phone), meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Unread summary for the sidebar dot / dashboard notification. Scoped to the
// actor's visible chats (same rules as the chat list).
router.get('/unread-count', async (req, res, next) => {
  try {
    res.json({ data: await unreadSummary(req.tenant, req.user), meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Create a CRM lead from an existing (unlinked) chat and assign it to a chosen
// counsellor, then link every chat row for that number to the new lead. Admins
// and account_managers only — they can assign to anyone; managers/counsellors
// shouldn't mint arbitrary owners from here.
const createLeadSchema = z.object({
  name: z.string().min(1).max(200),
  assigned_to: z.string().uuid(),
  email: z.string().email().optional().or(z.literal('')),
});
router.post('/chats/:phone/create-lead',
  requireRole('super_admin', 'account_manager'),
  validate({ body: createLeadSchema }),
  async (req, res, next) => {
    try {
      const phone = normalizePhone(req.params.phone);
      if (!phone) throw forbidden('Invalid phone number');
      // Lazy import avoids a circular dep (leads/service ↔ whatsapp-inbox).
      const { createLead } = await import('../../leads/service.js');
      // Assign directly to the picked counsellor; skip round-robin so the
      // operator's choice is honored. on_duplicate:warn returns matches instead
      // of throwing if the number already has a lead (shouldn't, since this is
      // for unlinked chats, but be safe).
      const lead = await createLead(
        req.tenant,
        req.user,
        {
          name: req.body.name,
          whatsapp_number: phone,
          phone,
          email: req.body.email || undefined,
          assigned_to: req.body.assigned_to,
          first_touch_source: 'whatsapp',
        },
        { on_duplicate: 'warn', skip_auto_assign: true },
      );
      if (lead?.id) await linkChatToLead(req.tenant, phone, lead.id);
      res.status(201).json({ data: { lead_id: lead?.id ?? null }, meta: { requestId: req.id } });
    } catch (err) { next(err); }
  });

// Locally-registered templates (portal-approved id + body + variables). Used by
// the composer's template picker. Any authed user can read; only super_admin
// can add/delete.
router.get('/templates', async (req, res, next) => {
  try {
    res.json({ data: await listTemplates(req.tenant), meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

const templateSchema = z.object({
  template_id: z.string().min(1).max(200),
  label: z.string().min(1).max(120),
  body: z.string().min(1).max(4096),
  category: z.string().max(40).optional(),
});
router.post('/templates', requireRole('super_admin'), validate({ body: templateSchema }), async (req, res, next) => {
  try {
    const row = await addTemplate(req.tenant, req.body, req.user.id);
    res.status(201).json({ data: row, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/templates/:id', requireRole('super_admin'), async (req, res, next) => {
  try {
    await deleteTemplate(req.tenant, req.params.id);
    res.status(204).end();
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

    // Scope check: if a chat exists for this number, the caller must be allowed
    // to see it (own lead / team / branch / all). If no chat exists yet, allow —
    // the caller is starting a new conversation (e.g. with a lead they own).
    const allAccess = req.user.role === 'super_admin' || req.user.role === 'account_manager';
    if (!allAccess) {
      const inScope = await resolveChatForActor(req.tenant, req.user, phone);
      const anyChat = await resolveChatForActor(req.tenant, { role: 'super_admin' }, phone);
      if (anyChat && !inScope) throw forbidden('This conversation belongs to another counsellor.');
    }

    const s = await getSettings(req.tenant);
    if (!(s.appKey && s.authKey && s.deviceId)) throw conflict('WhatsApp is not configured. Add WABridge keys in Settings → WhatsApp.');
    const creds = credsFor(s);
    const ownerId = await resolveInboxOwner(req.tenant);

    let waMessageId = null;
    let body = req.body.message || '';
    try {
      if (req.body.type === 'template') {
        const out = await wabridge.sendTemplate(creds, { to: phone, templateId: req.body.templateId, variables: req.body.variables, tenant: req.tenant });
        waMessageId = out.messageId;
        // Store the rendered template text (placeholders filled with the sent
        // variables) so the chat thread shows the real message, not "[template id]".
        body = body || await renderTemplateBody(req.tenant, req.body.templateId, req.body.variables || []);
      } else {
        const out = await wabridge.sendText(creds, { to: phone, message: req.body.message, tenant: req.tenant });
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
    await markChatRead(req.tenant, req.user, req.params.phone);
    res.status(204).end();
  } catch (err) { next(err); }
});

// Hard-delete an entire conversation (messages + chat row). super_admin only.
// The linked lead is left intact — this only clears the WhatsApp thread.
router.delete('/chats/:phone', requireRole('super_admin'), async (req, res, next) => {
  try {
    const phone = normalizePhone(req.params.phone);
    if (!phone) throw forbidden('Invalid phone number');
    const result = await deleteChat(req.tenant, phone);
    res.json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
