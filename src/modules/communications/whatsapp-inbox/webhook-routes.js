// Tenant-scoped WhatsApp inbound webhook — UNauthenticated (WABridge/Meta call
// it). Mounted OUTSIDE the auth chain. The tenant is in the URL, so routing is
// deterministic (no phone-directory guessing, no default tenant):
//   POST /whatsapp/webhook/:slug?token=<tenant webhook token>
//   GET  /whatsapp/webhook/:slug   — Meta verify handshake (if using Meta)
//
// Each tenant registers ITS OWN url (with its token) in WABridge → messages land
// in the right tenant. The token prevents another tenant/attacker from posting
// into a tenant they don't own.
import express from 'express';
import { logger } from '../../../lib/logger.js';
import { resolveTenantBySlug } from '../../../db/tenant.js';
import { env } from '../../../config/env.js';
import { getSettings, recordInbound, applyStatus } from './service.js';

const router = express.Router({ mergeParams: true });

// Meta verification handshake (only relevant if a tenant points Meta here).
router.get('/:slug', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const tenant = await resolveTenantBySlug(req.params.slug).catch(() => null);
  const expected = tenant ? (await getSettings(tenant)).webhookToken : null;
  if (mode === 'subscribe' && token && (token === expected || token === env.WA_WEBHOOK_VERIFY_TOKEN)) {
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: 'verification failed' });
});

// WABridge inbound parser (field names probed; raw body logged once to tune).
const parseWabridge = (body) => {
  const d = body.data || body.message || body;
  const from = d.from || d.from_number || d.sender || d.mobile || d.phone || d.wa_id || d.number;
  if (!from) return null;
  const text = d.message || d.text || d.body || d.content || (typeof d.text?.body === 'string' ? d.text.body : '');
  const id = d.message_id || d.messageid || d.id || d.msg_id || null;
  const type = d.type || (text ? 'text' : 'unknown');
  const name = d.name || d.sender_name || d.pushname || d.profile_name || null;
  const mediaUrl = d.media_url || d.media || d.file_url || d.url || null;
  return { from: String(from).replace(/\D/g, ''), text, id, type, name, mediaUrl };
};

// Meta message → { text, mediaId, mimeType }.
const parseMeta = (msg) => {
  const type = msg.type || 'unknown';
  const o = { type, text: '', mediaId: null, mimeType: null };
  switch (type) {
    case 'text': o.text = msg.text?.body || ''; break;
    case 'image': o.mediaId = msg.image?.id; o.mimeType = msg.image?.mime_type; o.text = msg.image?.caption || ''; break;
    case 'video': o.mediaId = msg.video?.id; o.mimeType = msg.video?.mime_type; o.text = msg.video?.caption || ''; break;
    case 'audio': case 'voice': o.mediaId = msg[type]?.id; o.mimeType = msg[type]?.mime_type; break;
    case 'document': o.mediaId = msg.document?.id; o.mimeType = msg.document?.mime_type; o.text = msg.document?.caption || msg.document?.filename || ''; break;
    case 'sticker': o.mediaId = msg.sticker?.id; o.mimeType = msg.sticker?.mime_type; break;
    default: o.text = `[${type} message]`;
  }
  return o;
};

router.post('/:slug', express.json({ limit: '2mb' }), (req, res) => {
  res.sendStatus(200);
  (async () => {
    try {
      const tenant = await resolveTenantBySlug(req.params.slug).catch(() => null);
      if (!tenant) { logger.warn({ slug: req.params.slug }, 'wa webhook: unknown tenant slug'); return; }
      const settings = await getSettings(tenant);
      // Token guard: if the tenant set a token, require it (query or header).
      const got = req.query.token || req.headers['x-webhook-token'];
      if (settings.webhookToken && got !== settings.webhookToken) {
        logger.warn({ slug: req.params.slug }, 'wa webhook: bad token');
        return;
      }

      const body = req.body || {};

      // ── Meta envelope ──
      if (body.object === 'whatsapp_business_account') {
        for (const entry of body.entry || []) {
          for (const change of entry.changes || []) {
            if (change.field !== 'messages') continue;
            const value = change.value || {};
            for (const st of value.statuses || []) await applyStatus(tenant, st.id, st.status);
            const senderName = value.contacts?.[0]?.profile?.name || null;
            for (const msg of value.messages || []) {
              const p = parseMeta(msg);
              await recordInbound({
                tenant, phone: msg.from, waMessageId: msg.id, type: p.type, text: p.text,
                mediaId: p.mediaId, mimeType: p.mimeType,
                timestamp: msg.timestamp ? parseInt(msg.timestamp, 10) * 1000 : Date.now(), senderName,
              });
            }
          }
        }
        return;
      }

      // ── WABridge (flat) ──
      logger.info({ slug: req.params.slug, raw: JSON.stringify(body).slice(0, 1500) }, 'wa webhook WABridge payload');
      const wb = parseWabridge(body);
      if (!wb?.from) { logger.warn('wa webhook: unrecognized inbound payload'); return; }
      await recordInbound({
        tenant, phone: wb.from, waMessageId: wb.id, type: wb.type, text: wb.text,
        mediaUrl: wb.mediaUrl, timestamp: Date.now(), senderName: wb.name,
      });
      logger.info({ slug: req.params.slug, from: wb.from }, 'wa webhook (WABridge) inbound stored');
    } catch (err) {
      logger.error({ err: err.message }, 'wa webhook processing failed');
    }
  })();
});

export default router;
