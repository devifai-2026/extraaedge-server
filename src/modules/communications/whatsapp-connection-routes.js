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
    res.json({ data: { ...row, live_status: live?.status ?? null }, meta: { requestId: req.id } });
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
         SELECT lead_id, body AS last_body, sent_at AS at, 'out' AS direction
           FROM message_log
          WHERE channel = 'whatsapp' AND user_id = $1 AND lead_id IS NOT NULL
         UNION ALL
         SELECT lead_id, body AS last_body, received_at AS at, 'in' AS direction
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

// GET /messages?lead_id= — merged outbound + inbound timeline for one lead,
// scoped to this user's number. Marks inbound as read as a side effect.
router.get('/messages', validate({ query: z.object({ lead_id: z.string().uuid() }) }), async (req, res, next) => {
  try {
    const leadId = req.query.lead_id;
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT 'out' AS direction, id, body, status, sent_at AS at, provider_message_id
         FROM message_log
        WHERE channel = 'whatsapp' AND user_id = $1 AND lead_id = $2
       UNION ALL
       SELECT 'in' AS direction, id, body, NULL AS status, received_at AS at, provider_message_id
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

// POST /send { lead_id, body } — free-text via the user's OWN connected number.
const sendSchema = z.object({ lead_id: z.string().uuid(), body: z.string().min(1).max(4096) });
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

    const { rows: [logRow] } = await tenantQuery(
      req.tenant,
      `INSERT INTO message_log
          (lead_id, user_id, channel, recipient, provider, status, body, user_whatsapp_session_id)
       VALUES ($1,$2,'whatsapp',$3,'wwebjs','queued',$4,$5) RETURNING id`,
      [lead.id, req.user.id, recipient, req.body.body, sess.id],
    );

    try {
      const sent = await waGateway.sendMessage(req.tenant.id, req.user.id, { to: recipient, body: req.body.body });
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

export default router;
