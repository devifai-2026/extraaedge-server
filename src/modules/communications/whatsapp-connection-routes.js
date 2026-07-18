// Per-user WhatsApp connection (whatsapp-web.js). Every authenticated user
// links their OWN number, sends free-text from it, and receives replies routed
// to them. All queries are keyed to req.user.id, so there's no cross-user
// access and no requireRole gate — a user only ever touches their own session.
//
// The live Client lives in the gateway process; this module proxies through
// src/lib/wa-gateway.js and reads/writes the durable rows in
// user_whatsapp_sessions + the unified message_log / message_reply tables
// (provider='wwebjs').
import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { notFound, forbidden, conflict, rateLimited } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { headObject, getDownloadSignedUrl } from '../../lib/r2.js';
import * as waGateway from '../../lib/wa-gateway.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// Lightweight per-user send throttle (ban-risk mitigation). In-memory sliding
// window; product-wide express-rate-limit is intentionally disabled, so we keep
// this local and minimal rather than re-introducing that mechanism.
const sendTimestamps = new Map(); // userId -> number[] (ms)
const allowSend = (userId) => {
  const now = Date.now();
  const windowMs = 60_000;
  const arr = (sendTimestamps.get(userId) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= env.WA_SEND_RATE_PER_MINUTE) {
    sendTimestamps.set(userId, arr);
    return false;
  }
  arr.push(now);
  sendTimestamps.set(userId, arr);
  return true;
};

// Ensure a session row exists for this user (one per user; UNIQUE(user_id)).
const ensureSessionRow = async (tenant, userId) => {
  await tenantQuery(
    tenant,
    `INSERT INTO user_whatsapp_sessions (user_id, status)
     VALUES ($1, 'pending_qr')
     ON CONFLICT (user_id) DO UPDATE SET status = 'pending_qr', updated_at = now()`,
    [userId],
  );
};

// POST /connect — start (or restart) the QR/link flow. The QR itself arrives
// asynchronously over the socket as a 'whatsapp_qr' notification.
router.post('/connect', async (req, res, next) => {
  try {
    await ensureSessionRow(req.tenant, req.user.id);
    const out = await waGateway.startSession(req.tenant.id, req.user.id, req.tenant.slug);
    res.status(202).json({ data: { status: out.status ?? 'pending_qr' }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// GET /status — durable row, reconciled with the gateway's live view.
router.get('/status', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT status, phone, connected_at, last_qr_at, last_seen_at
         FROM user_whatsapp_sessions WHERE user_id = $1`,
      [req.user.id],
    );
    const row = rows[0] ?? { status: 'disconnected', phone: null };
    let live = null;
    try { live = await waGateway.getStatus(req.tenant.id, req.user.id); } catch { /* gateway down → fall back to DB */ }
    // Surface the live QR (if any) so the FE can PULL it by polling /status —
    // a reliable fallback when the socket push doesn't land.
    res.json({
      data: { ...row, live_status: live?.status ?? null, qr: live?.qr ?? null },
      meta: { requestId: req.id },
    });
  } catch (err) { next(err); }
});

// POST /logout — unlink the device, drop the session blob.
router.post('/logout', async (req, res, next) => {
  try {
    await waGateway.logoutSession(req.tenant.id, req.user.id);
    await tenantQuery(
      req.tenant,
      `UPDATE user_whatsapp_sessions SET status = 'logged_out', phone = NULL WHERE user_id = $1`,
      [req.user.id],
    );
    res.status(204).end();
  } catch (err) { next(err); }
});

// GET /conversations — leads this user has WhatsApp history with (their number),
// newest activity first, with last message + unread count.
router.get('/conversations', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `WITH wa AS (
         SELECT lead_id,
                COALESCE(NULLIF(body, ''),
                         CASE WHEN media_r2_key IS NOT NULL
                              THEN '📎 ' || COALESCE(media_filename, 'Attachment') END,
                         '') AS last_body,
                sent_at AS at, 'out' AS direction
           FROM message_log
          WHERE channel = 'whatsapp' AND user_id = $1 AND lead_id IS NOT NULL
         UNION ALL
         SELECT lead_id,
                COALESCE(NULLIF(body, ''),
                         CASE WHEN media_urls IS NOT NULL AND array_length(media_urls, 1) > 0
                              THEN '📎 Attachment' END,
                         '') AS last_body,
                received_at AS at, 'in' AS direction
           FROM message_reply
          WHERE channel = 'whatsapp' AND routed_to_user_id = $1 AND lead_id IS NOT NULL
       ),
       ranked AS (
         SELECT DISTINCT ON (lead_id) lead_id, last_body, at, direction
           FROM wa ORDER BY lead_id, at DESC
       )
       SELECT r.lead_id, r.last_body, r.at AS last_at, r.direction,
              l.name AS lead_name, l.phone, l.whatsapp_number,
              (SELECT count(*)::int FROM message_reply mr
                 WHERE mr.lead_id = r.lead_id AND mr.channel = 'whatsapp'
                   AND mr.routed_to_user_id = $1 AND mr.is_read = false) AS unread
         FROM ranked r
         LEFT JOIN leads l ON l.id = r.lead_id
        ORDER BY r.at DESC
        LIMIT 200`,
      [req.user.id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// GET /all-chats — the FULL WhatsApp inbox mirrored from the linked account
// (wa_chats), not just CRM leads. Each row carries lead_id + lead_name when the
// chat matches a known lead, so the UI can flag it and offer "convert to lead".
router.get('/all-chats', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT c.id, c.wa_jid, c.phone, c.is_group, c.last_body, c.last_at, c.unread,
              COALESCE(l.name, c.name) AS name,
              c.lead_id, l.name AS lead_name
         FROM wa_chats c
         LEFT JOIN leads l ON l.id = c.lead_id AND l.deleted_at IS NULL
        WHERE c.owner_user_id = $1
        ORDER BY c.last_at DESC NULLS LAST
        LIMIT 500`,
      [req.user.id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// GET /all-messages?chat_id= — timeline for one inbox chat. Marks it read.
router.get('/all-messages', validate({ query: z.object({ chat_id: z.string().uuid() }) }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT id, direction, body, media_r2_key,
              CASE WHEN media_r2_key IS NULL THEN NULL ELSE ARRAY[media_r2_key] END AS media_keys,
              media_type, at, status, provider_message_id
         FROM wa_messages
        WHERE owner_user_id = $1 AND chat_id = $2
        ORDER BY at ASC
        LIMIT 500`,
      [req.user.id, req.query.chat_id],
    );
    await tenantQuery(
      req.tenant,
      `UPDATE wa_chats SET unread = 0 WHERE id = $1 AND owner_user_id = $2`,
      [req.query.chat_id, req.user.id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// GET /messages?lead_id= — merged outbound + inbound timeline for one lead,
// scoped to this user's number. Marks inbound as read as a side effect.
router.get('/messages', validate({ query: z.object({ lead_id: z.string().uuid() }) }), async (req, res, next) => {
  try {
    const leadId = req.query.lead_id;
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT 'out' AS direction, id, body, status, sent_at AS at, provider_message_id,
              media_type, CASE WHEN media_r2_key IS NULL THEN NULL ELSE ARRAY[media_r2_key] END AS media_keys
         FROM message_log
        WHERE channel = 'whatsapp' AND user_id = $1 AND lead_id = $2
       UNION ALL
       SELECT 'in' AS direction, id, body, NULL AS status, received_at AS at, provider_message_id,
              NULL AS media_type, media_urls AS media_keys
         FROM message_reply
        WHERE channel = 'whatsapp' AND routed_to_user_id = $1 AND lead_id = $2
        ORDER BY at ASC NULLS LAST
        LIMIT 500`,
      [req.user.id, leadId],
    );
    await tenantQuery(
      req.tenant,
      `UPDATE message_reply SET is_read = true
        WHERE channel = 'whatsapp' AND routed_to_user_id = $1 AND lead_id = $2 AND is_read = false`,
      [req.user.id, leadId],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// POST /send { lead_id, body?, media_r2_key? } — free-text and/or an attachment
// via the user's OWN connected number. `media_r2_key` points at an object the
// FE already uploaded through the shared /uploads presign pipeline; the body is
// then the attachment's caption. At least one of body / media_r2_key required.
const sendSchema = z
  .object({
    lead_id: z.string().uuid(),
    body: z.string().max(4096).optional().default(''),
    media_r2_key: z.string().min(1).max(512).optional(),
  })
  .refine((v) => (v.body && v.body.trim().length > 0) || v.media_r2_key, {
    message: 'Provide a message body or an attachment',
    path: ['body'],
  });
router.post('/send', validate({ body: sendSchema }), async (req, res, next) => {
  try {
    if (!allowSend(req.user.id)) throw rateLimited(60);

    const { rows: [lead] } = await tenantQuery(
      req.tenant,
      `SELECT id, name, whatsapp_number, phone FROM leads WHERE id = $1 AND deleted_at IS NULL`,
      [req.body.lead_id],
    );
    if (!lead) throw notFound('Lead not found');
    const recipient = lead.whatsapp_number || lead.phone;
    if (!recipient) throw forbidden('Lead has no WhatsApp/phone number');

    const { rows: [sess] } = await tenantQuery(
      req.tenant,
      `SELECT id, status FROM user_whatsapp_sessions WHERE user_id = $1`,
      [req.user.id],
    );
    if (!sess || sess.status !== 'connected') throw conflict('Your WhatsApp is not connected. Connect it first.');

    // Resolve the attachment: confirm it exists in GCS (MIME/size come from the
    // object itself) and mint a short-lived signed URL the gateway can fetch.
    let media = null;
    let mediaType = null;
    let mediaFilename = null;
    if (req.body.media_r2_key) {
      const head = await headObject(req.body.media_r2_key);
      if (!head) throw notFound('Attachment not found; upload it first');
      mediaType = head.ContentType || 'application/octet-stream';
      mediaFilename = req.body.media_r2_key.split('/').pop() || 'attachment';
      const signedUrl = await getDownloadSignedUrl({ key: req.body.media_r2_key });
      media = { signedUrl, filename: mediaFilename, mimetype: mediaType };
    }

    const { rows: [logRow] } = await tenantQuery(
      req.tenant,
      `INSERT INTO message_log
          (lead_id, user_id, channel, recipient, provider, status, body,
           media_r2_key, media_type, media_filename, user_whatsapp_session_id)
       VALUES ($1,$2,'whatsapp',$3,'wwebjs','queued',$4,$5,$6,$7,$8) RETURNING id`,
      [lead.id, req.user.id, recipient, req.body.body, req.body.media_r2_key ?? null, mediaType, mediaFilename, sess.id],
    );

    try {
      const sent = await waGateway.sendMessage(req.tenant.id, req.user.id, { to: recipient, body: req.body.body, media });
      await tenantQuery(
        req.tenant,
        `UPDATE message_log SET status = 'sent', provider_message_id = $2, sent_at = now() WHERE id = $1`,
        [logRow.id, sent.provider_message_id ?? null],
      );
      res.status(202).json({ data: { message_log_id: logRow.id, status: 'sent' }, meta: { requestId: req.id } });
    } catch (sendErr) {
      await tenantQuery(
        req.tenant,
        `UPDATE message_log SET status = 'failed', error = $2, failed_at = now() WHERE id = $1`,
        [logRow.id, sendErr.message?.slice(0, 500) ?? 'send failed'],
      );
      throw sendErr;
    }
  } catch (err) { next(err); }
});

// POST /all-send { chat_id, body } — send a free-text message to ANY inbox chat
// (lead or not), addressed by the chat's stored phone. Records the outbound in
// wa_messages so it shows in the thread immediately.
const allSendSchema = z.object({ chat_id: z.string().uuid(), body: z.string().min(1).max(4096) });
router.post('/all-send', validate({ body: allSendSchema }), async (req, res, next) => {
  try {
    if (!allowSend(req.user.id)) throw rateLimited(60);

    const { rows: [chat] } = await tenantQuery(
      req.tenant,
      `SELECT id, wa_jid, phone, is_group FROM wa_chats WHERE id = $1 AND owner_user_id = $2`,
      [req.body.chat_id, req.user.id],
    );
    if (!chat) throw notFound('Chat not found');
    if (chat.is_group) throw forbidden('Sending to groups is not supported');
    if (chat.wa_jid.endsWith('@newsletter')) throw forbidden('Cannot send to a channel/newsletter');
    if (!chat.wa_jid) throw forbidden('Chat has no address');

    const { rows: [sess] } = await tenantQuery(
      req.tenant,
      `SELECT status FROM user_whatsapp_sessions WHERE user_id = $1`,
      [req.user.id],
    );
    if (!sess || sess.status !== 'connected') throw conflict('Your WhatsApp is not connected. Connect it first.');

    // Send to the FULL stored JID (handles @s.whatsapp.net and @lid alike),
    // not a re-derived phone — @lid chats have no usable phone number.
    const sent = await waGateway.sendMessage(req.tenant.id, req.user.id, { jid: chat.wa_jid, body: req.body.body });

    // Record the outbound in the inbox thread (the gateway also mirrors it via
    // messages.upsert, but recording here makes it appear instantly).
    await tenantQuery(
      req.tenant,
      `INSERT INTO wa_messages (chat_id, owner_user_id, provider_message_id, direction, body, at, status)
       VALUES ($1,$2,$3,'out',$4, now(), 'sent')
       ON CONFLICT (owner_user_id, provider_message_id) DO NOTHING`,
      [chat.id, req.user.id, sent.provider_message_id ?? null, req.body.body],
    );
    await tenantQuery(
      req.tenant,
      `UPDATE wa_chats SET last_body = $2, last_at = now() WHERE id = $1`,
      [chat.id, req.body.body],
    );

    res.status(202).json({ data: { status: 'sent' }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
