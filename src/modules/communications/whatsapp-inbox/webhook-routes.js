// Meta WhatsApp Cloud API webhook — UNauthenticated (Meta's servers call it).
// Mounted OUTSIDE the authRequired/tenantRequired chain in src/routes.js.
//   GET  /whatsapp/webhook  — Meta verification handshake
//   POST /whatsapp/webhook  — inbound messages + delivery/read status
//
// Multi-tenant: each inbound sender is routed to a tenant via the phone→tenant
// directory (service.resolveTenantForPhone), falling back to WA_DEFAULT_TENANT_SLUG.
import express from 'express';
import { env } from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';
import { resolveTenantForPhone, recordInbound, applyStatus } from './service.js';

const router = express.Router();

// Meta verification: echo hub.challenge when the verify token matches.
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === env.WA_WEBHOOK_VERIFY_TOKEN) {
    logger.info('wa webhook verified');
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: 'verification failed' });
});

// Extract text + media descriptor from a Meta inbound message node.
const parseMessage = (msg) => {
  const type = msg.type || 'unknown';
  const base = { type, text: '', mediaId: null, mimeType: null };
  switch (type) {
    case 'text': base.text = msg.text?.body || ''; break;
    case 'image': base.mediaId = msg.image?.id; base.mimeType = msg.image?.mime_type; base.text = msg.image?.caption || ''; break;
    case 'video': base.mediaId = msg.video?.id; base.mimeType = msg.video?.mime_type; base.text = msg.video?.caption || ''; break;
    case 'audio': case 'voice': base.mediaId = msg[type]?.id; base.mimeType = msg[type]?.mime_type; break;
    case 'document': base.mediaId = msg.document?.id; base.mimeType = msg.document?.mime_type; base.text = msg.document?.caption || msg.document?.filename || ''; break;
    case 'sticker': base.mediaId = msg.sticker?.id; base.mimeType = msg.sticker?.mime_type; break;
    default: base.text = `[${type} message]`;
  }
  return base;
};

// POST — ack immediately (Meta requires < 20s), then process.
// Extract (from, text, id, mediaId, mimeType, name) from a WABridge inbound
// payload. WABridge's exact shape varies, so we probe several common field
// names. The full raw body is logged (below) so we can tighten this once we see
// a real payload.
const parseWabridge = (body) => {
  // Common WABridge inbound shapes: { data: {...} } or flat.
  const d = body.data || body.message || body;
  const from = d.from || d.from_number || d.sender || d.mobile || d.phone || d.wa_id || d.number;
  if (!from) return null;
  const text = d.message || d.text || d.body || d.content || (typeof d.text?.body === 'string' ? d.text.body : '');
  const id = d.message_id || d.messageid || d.id || d.msg_id || null;
  const type = d.type || (text ? 'text' : 'unknown');
  const name = d.name || d.sender_name || d.pushname || d.profile_name || null;
  // Media (best-effort): a public URL WABridge already hosts.
  const mediaUrl = d.media_url || d.media || d.file_url || d.url || null;
  return { from: String(from).replace(/\D/g, ''), text, id, type, name, mediaUrl };
};

router.post('/', express.json({ limit: '2mb' }), (req, res) => {
  res.sendStatus(200);
  (async () => {
    try {
      const body = req.body || {};

      // ── WABridge inbound (not Meta's whatsapp_business_account envelope) ──
      if (body.object !== 'whatsapp_business_account') {
        // Log the raw shape ONCE so we can lock the parser to WABridge's format.
        logger.info({ raw: JSON.stringify(body).slice(0, 1500) }, 'wa webhook non-Meta payload (WABridge?)');
        const wb = parseWabridge(body);
        if (!wb || !wb.from) { logger.warn('wa webhook: unrecognized inbound payload'); return; }
        const tenant = await resolveTenantForPhone(wb.from);
        if (!tenant) { logger.warn({ from: wb.from }, 'wa webhook: no tenant for sender'); return; }
        await recordInbound({
          tenant, phone: wb.from, waMessageId: wb.id, type: wb.type,
          text: wb.text, mediaUrl: wb.mediaUrl, timestamp: Date.now(), senderName: wb.name,
        });
        logger.info({ from: wb.from }, 'wa webhook (WABridge) inbound stored');
        return;
      }

      // ── Meta Cloud API inbound ──
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field !== 'messages') continue;
          const value = change.value || {};

          // Delivery/read status updates.
          for (const st of value.statuses || []) {
            const phone = st.recipient_id;
            const tenant = await resolveTenantForPhone(phone);
            if (tenant) await applyStatus(tenant, st.id, st.status);
          }

          // Incoming messages.
          const senderName = value.contacts?.[0]?.profile?.name || null;
          for (const msg of value.messages || []) {
            const from = msg.from; // digits (E.164 without +)
            const tenant = await resolveTenantForPhone(from);
            if (!tenant) { logger.warn({ from }, 'wa webhook: no tenant for sender'); continue; }
            const p = parseMessage(msg);
            await recordInbound({
              tenant,
              phone: from,
              waMessageId: msg.id,
              type: p.type,
              text: p.text,
              mediaId: p.mediaId,
              mimeType: p.mimeType,
              timestamp: msg.timestamp ? parseInt(msg.timestamp, 10) * 1000 : Date.now(),
              senderName,
            });
            logger.info({ from, type: p.type }, 'wa webhook inbound stored');
          }
        }
      }
    } catch (err) {
      logger.error({ err: err.message }, 'wa webhook processing failed');
    }
  })();
});

export default router;
