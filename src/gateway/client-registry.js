// Singleton in-memory registry of Baileys WhatsApp socket connections.
//
// Baileys speaks the WhatsApp multi-device protocol directly over a WebSocket —
// NO headless browser, NO Chromium — so the gateway is a plain, lightweight
// Node process (deployable on a free tier). We keep one live socket per user in
// a Map keyed by `${tenantId}:${userId}`; only the process holding user X's
// socket can send for X, so the API addresses us directly over internal HTTP.
//
// Each socket's async events (qr / open / close / inbound message / receipt)
// update the tenant DB and are pushed to the owning user's browser via
// notify-api → API socket.io. Session auth is persisted in Postgres
// (baileys-auth-pg) so restarts/redeploys re-link without a fresh QR.
import { nanoid } from 'nanoid';
import {
  makeWASocket, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, Browsers,
} from '@whiskeysockets/baileys';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { putObject, buildKey } from '../lib/r2.js';
import { usePostgresAuthState, clearPostgresAuthState, listConnectedUserIds } from './baileys-auth-pg.js';
import { ingestChats, ingestContacts, insertMessage } from './wa-inbox.js';
import { notifyApi } from './notify-api.js';

// key -> { sock, status, phone, tenantId, userId, tenantSlug, lastQr, saveCreds, wantLogout }
const clients = new Map();

const keyOf = (tenantId, userId) => `${tenantId}:${userId}`;

// Baileys chat JIDs are "<countrycode><number>@s.whatsapp.net" for 1:1.
const jidOf = (to) => `${String(to).replace(/\D+/g, '')}@s.whatsapp.net`;
const numberFromJid = (jid) => String(jid || '').split('@')[0].split(':')[0];

// updateSessionStatus accepts literal values or the string 'now()' to set a
// timestamp to the DB clock (unparameterized) while binding everything else.
const updateSessionStatus = async (tenantId, userId, fields) => {
  const tenant = await resolveTenantById(tenantId);
  if (!tenant) return;
  const sets = [];
  const params = [userId];
  for (const [col, val] of Object.entries(fields)) {
    if (val === 'now()') {
      sets.push(`${col} = now()`);
    } else {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (!sets.length) return;
  await tenantQuery(
    tenant,
    `UPDATE user_whatsapp_sessions SET ${sets.join(', ')} WHERE user_id = $1`,
    params,
  ).catch((err) => logger.warn({ tenantId, userId, err: err.message }, 'wa updateSessionStatus failed'));
};

// ---- inbound message handling ----

const handleInbound = async (entry, msg) => {
  const { tenantId, userId } = entry;
  try {
    if (msg.key?.fromMe) return;
    const remoteJid = msg.key?.remoteJid || '';
    // Only 1:1 chats (ignore groups @g.us, status @broadcast, newsletters).
    if (!remoteJid.endsWith('@s.whatsapp.net')) return;

    const tenant = await resolveTenantById(tenantId);
    if (!tenant) return;

    const fromNumber = numberFromJid(remoteJid);
    const last10 = fromNumber.length > 10 ? fromNumber.slice(-10) : fromNumber;

    const { rows: matched } = await tenantQuery(
      tenant,
      `SELECT id FROM leads
        WHERE deleted_at IS NULL
          AND (right(regexp_replace(coalesce(whatsapp_number,''), '\\D', '', 'g'), 10) = $1
            OR right(regexp_replace(coalesce(phone,''),           '\\D', '', 'g'), 10) = $1)
        LIMIT 1`,
      [last10],
    );
    const leadId = matched[0]?.id ?? null;

    const { rows: sess } = await tenantQuery(
      tenant,
      `SELECT id FROM user_whatsapp_sessions WHERE user_id = $1`,
      [userId],
    );

    // Extract text (may be a plain conversation or a caption on media).
    const m = msg.message || {};
    const body =
      m.conversation ||
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.videoMessage?.caption ||
      m.documentMessage?.caption ||
      '';

    // If media is attached, download and stash it in GCS; store the object KEY
    // in message_reply.media_urls (FE resolves to a signed URL on demand).
    let mediaKeys = null;
    let hasMedia = false;
    const mediaNode = m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage;
    if (mediaNode) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: entry.sock.updateMediaMessage });
        if (buffer?.length) {
          const mimetype = mediaNode.mimetype || 'application/octet-stream';
          const ext = (mimetype.split('/')[1] || 'bin').split(';')[0];
          const key = buildKey({ tenantSlug: tenant.slug, purpose: 'whatsapp_inbound', id: nanoid(24), ext });
          await putObject({ key, body: buffer, contentType: mimetype });
          mediaKeys = [key];
          hasMedia = true;
        }
      } catch (mErr) {
        logger.warn({ tenantId, userId, err: mErr.message }, 'wa inbound media download failed');
      }
    }

    await tenantQuery(
      tenant,
      `INSERT INTO message_reply
          (lead_id, channel, provider_message_id, body, media_urls, received_at, routed_to_user_id, user_whatsapp_session_id)
       VALUES ($1,'whatsapp',$2,$3,$4, now(), $5, $6)`,
      [leadId, msg.key?.id ?? null, body, mediaKeys, userId, sess[0]?.id ?? null],
    );
    notifyApi(tenantId, userId, 'whatsapp_message', {
      lead_id: leadId,
      from: fromNumber,
      body,
      has_media: hasMedia,
      received_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ tenantId, userId, err: err.message }, 'wa inbound message handling failed');
  }
};

// Delivery/read receipts. Baileys ack status: 2=server(sent), 3=delivered,
// 4=read, 5=played. Map to our sent/delivered/seen.
const handleReceipt = async (entry, update) => {
  const { tenantId, userId } = entry;
  try {
    const providerMessageId = update.key?.id;
    const statusNum = update.update?.status;
    const map = { 2: 'sent', 3: 'delivered', 4: 'seen', 5: 'seen' };
    const status = map[statusNum];
    if (!providerMessageId || !status) return;
    const tenant = await resolveTenantById(tenantId);
    if (!tenant) return;
    await tenantQuery(
      tenant,
      `UPDATE message_log
          SET status = $2,
              delivered_at = CASE WHEN $2='delivered' THEN now() ELSE delivered_at END,
              seen_at      = CASE WHEN $2='seen'      THEN now() ELSE seen_at END
        WHERE provider_message_id = $1`,
      [providerMessageId, status],
    );
    notifyApi(tenantId, userId, 'whatsapp_status', { provider_message_id: providerMessageId, status });
  } catch (err) {
    logger.warn({ tenantId, userId, err: err.message }, 'wa receipt handling failed');
  }
};

// ---- per-socket event wiring ----

const wireEvents = (entry) => {
  const { sock, tenantId, userId } = entry;

  sock.ev.on('creds.update', entry.saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      entry.status = 'pending_qr';
      entry.lastQr = qr;
      await updateSessionStatus(tenantId, userId, { status: 'pending_qr', last_qr_at: 'now()' });
      notifyApi(tenantId, userId, 'whatsapp_qr', { qr });
    }

    if (connection === 'open') {
      entry.status = 'connected';
      entry.readyAt = Date.now();
      const phone = numberFromJid(sock.user?.id);
      entry.phone = phone;
      await updateSessionStatus(tenantId, userId, {
        status: 'connected',
        phone,
        connected_at: 'now()',
        last_seen_at: 'now()',
      });
      notifyApi(tenantId, userId, 'whatsapp_ready', { phone });
      logger.info({ tenantId, userId, phone }, 'wa socket open');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      clients.delete(keyOf(tenantId, userId));

      if (loggedOut || entry.wantLogout) {
        // Device unlinked (or we asked to log out): drop the persisted session.
        await clearPostgresAuthState(tenantId, userId);
        entry.status = 'logged_out';
        await updateSessionStatus(tenantId, userId, { status: 'logged_out', phone: null });
        notifyApi(tenantId, userId, 'whatsapp_disconnected', { reason: 'logged_out' });
        logger.warn({ tenantId, userId }, 'wa socket logged out');
      } else {
        // Transient drop — keep the session blob and auto-reconnect. Baileys
        // restores from the persisted creds/keys, so no fresh QR is needed.
        entry.status = 'disconnected';
        await updateSessionStatus(tenantId, userId, { status: 'disconnected' });
        notifyApi(tenantId, userId, 'whatsapp_disconnected', { reason: String(statusCode ?? 'unknown') });
        logger.warn({ tenantId, userId, statusCode }, 'wa socket closed — reconnecting');
        startSession({ tenantId, userId, tenantSlug: entry.tenantSlug }).catch((err) =>
          logger.error({ tenantId, userId, err: err.message }, 'wa reconnect failed'));
      }
    }
  });

  // Inbound messages.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      // Mirror EVERY message (in/out, incl. our own) into the full inbox so all
      // chats show up; then run the lead-centric handling for genuine inbound.
      await mirrorToInbox(entry, msg);
      await handleInbound(entry, msg);
    }
  });

  // Delivery/read receipts.
  sock.ev.on('messages.update', async (updates) => {
    for (const u of updates) await handleReceipt(entry, u);
  });

  // ---- full-inbox sync (all chats, not just CRM leads) ----

  // Bulk history dump on link/reconnect: chats + contacts + recent messages.
  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
    try {
      await ingestChats(tenantId, userId, chats || []);
      await ingestContacts(tenantId, userId, contacts || []);
      for (const msg of messages || []) await mirrorToInbox(entry, msg).catch?.(() => {});
      notifyApi(tenantId, userId, 'whatsapp_message', { sync: true });
    } catch (err) {
      logger.warn({ tenantId, userId, err: err.message }, 'wa history.set ingest failed');
    }
  });

  sock.ev.on('chats.upsert', async (chats) => {
    await ingestChats(tenantId, userId, chats || []).catch(() => {});
  });
  sock.ev.on('contacts.upsert', async (contacts) => {
    await ingestContacts(tenantId, userId, contacts || []).catch(() => {});
  });
};

// Mirror a message (in OR out, incl. our own sends and history) into the
// full-inbox tables. Best-effort; never throws into the event loop.
//
// Skips anything that has no displayable content — reactions, receipts,
// protocol/system messages, poll updates, etc. Those were showing up as empty
// bubbles. Only text and real media (image/video/audio/document/sticker) are
// stored.
const mirrorToInbox = async (entry, msg) => {
  try {
    const { tenantId, userId } = entry;
    const jid = msg.key?.remoteJid;
    const pmid = msg.key?.id;
    if (!jid || !pmid) return; // need a stable id for dedup

    // Unwrap ephemeral/view-once containers.
    const m = msg.message?.ephemeralMessage?.message
      || msg.message?.viewOnceMessage?.message
      || msg.message?.viewOnceMessageV2?.message
      || msg.message || {};

    const text =
      m.conversation || m.extendedTextMessage?.text ||
      m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || '';
    const hasMedia = !!(m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage);

    // Nothing to show (reaction, receipt, protocol msg, etc.) → don't store.
    if (!text && !hasMedia) return;

    const at = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : new Date();
    await insertMessage(tenantId, userId, {
      jid,
      providerMessageId: pmid,
      direction: msg.key?.fromMe ? 'out' : 'in',
      body: text || (hasMedia ? '📎 Attachment' : ''),
      at,
      name: msg.pushName || null,
    });
  } catch { /* best-effort */ }
};

// ---- public API (same surface the internal routes call) ----

export const startSession = async ({ tenantId, userId, tenantSlug }) => {
  const key = keyOf(tenantId, userId);
  const existing = clients.get(key);
  if (existing && (existing.status === 'pending_qr' || existing.status === 'connected')) {
    // Already live. Re-emit the current QR so a browser that reconnected or
    // re-mounted AFTER the QR first fired (a common socket-join race) gets it
    // immediately, instead of waiting up to ~20s for the next rotation.
    if (existing.status === 'pending_qr' && existing.lastQr) {
      notifyApi(tenantId, userId, 'whatsapp_qr', { qr: existing.lastQr });
    } else if (existing.status === 'connected') {
      notifyApi(tenantId, userId, 'whatsapp_ready', { phone: existing.phone ?? null });
    }
    return { status: existing.status, phone: existing.phone ?? null };
  }

  let slug = tenantSlug;
  if (!slug) {
    const tenant = await resolveTenantById(tenantId);
    slug = tenant?.slug;
  }

  const { state, saveCreds } = await usePostgresAuthState(tenantId, userId);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.appropriate('Chrome'),
    printQRInTerminal: false,
    // Pull whatever recent history WhatsApp syncs to a newly-linked device so the
    // inbox shows existing chats (not just CRM-lead conversations).
    syncFullHistory: true,
    markOnlineOnConnect: false,
    // A WhatsApp QR expires in ~20s. Baileys' default qrTimeout is much longer,
    // so the QR on screen can go stale before the user scans → "Invalid QR
    // Code". Rotate it every ~20s so a fresh, scannable QR is always shown
    // (the FE updates on each whatsapp_qr event).
    qrTimeout: 20_000,
    logger,
  });

  const entry = {
    sock, saveCreds, status: 'initializing', phone: null,
    tenantId, userId, tenantSlug: slug, lastQr: null, readyAt: null, wantLogout: false,
  };
  clients.set(key, entry);
  wireEvents(entry);

  return { status: 'initializing' };
};

export const getStatus = (tenantId, userId) => {
  const entry = clients.get(keyOf(tenantId, userId));
  if (!entry) return { status: 'not_loaded', phone: null, qr: null };
  // Include the current QR so the API/FE can PULL it via polling — this makes
  // QR delivery work even if the push callback (gateway→API socket) is flaky.
  return {
    status: entry.status,
    phone: entry.phone ?? null,
    qr: entry.status === 'pending_qr' ? entry.lastQr ?? null : null,
  };
};

// `media`, when present, is { signedUrl, filename, mimetype } — a short-lived
// GCS download URL. With media, the text `body` becomes the caption; without
// media it's a plain text message.
export const send = async ({ tenantId, userId, to, body, media }) => {
  const entry = clients.get(keyOf(tenantId, userId));
  if (!entry || entry.status !== 'connected') {
    const err = new Error('NOT_CONNECTED');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const jid = jidOf(to);

  let content;
  if (media?.signedUrl) {
    const mimetype = media.mimetype || 'application/octet-stream';
    const caption = body || undefined;
    if (mimetype.startsWith('image/')) {
      content = { image: { url: media.signedUrl }, caption, mimetype };
    } else if (mimetype.startsWith('video/')) {
      content = { video: { url: media.signedUrl }, caption, mimetype };
    } else if (mimetype.startsWith('audio/')) {
      content = { audio: { url: media.signedUrl }, mimetype };
    } else {
      content = { document: { url: media.signedUrl }, mimetype, fileName: media.filename || 'attachment', caption };
    }
  } else {
    content = { text: body };
  }

  const sent = await entry.sock.sendMessage(jid, content);
  return { provider_message_id: sent?.key?.id ?? null, status: 'sent' };
};

export const logout = async (tenantId, userId) => {
  const key = keyOf(tenantId, userId);
  const entry = clients.get(key);
  if (entry) {
    entry.wantLogout = true;
    try { await entry.sock.logout(); } catch { /* device may already be gone */ }
    try { entry.sock.end(undefined); } catch { /* ignore */ }
    clients.delete(key);
  }
  await clearPostgresAuthState(tenantId, userId);
  await updateSessionStatus(tenantId, userId, { status: 'logged_out', phone: null });
  return { ok: true };
};

export const clientCount = () => clients.size;

export const destroyAll = async () => {
  for (const entry of clients.values()) {
    try { entry.sock.end(undefined); } catch { /* ignore */ }
  }
  clients.clear();
};

// Re-link every previously-connected session from Postgres on boot, throttled
// so we don't open N sockets at once. Baileys restores from persisted creds.
export const restoreOnBoot = async () => {
  const { sysQuery } = await import('../db/system.js');
  const { rows: tenants } = await sysQuery(
    `SELECT id, slug FROM tenants WHERE status = 'active' AND deleted_at IS NULL`,
  );
  const concurrency = Math.max(1, env.WA_SESSION_RESTORE_CONCURRENCY);
  for (const t of tenants) {
    let userIds = [];
    try {
      userIds = await listConnectedUserIds(t.id);
    } catch (err) {
      logger.warn({ tenantId: t.id, err: err.message }, 'wa restore: list failed');
      continue;
    }
    for (let i = 0; i < userIds.length; i += concurrency) {
      const batch = userIds.slice(i, i + concurrency);
      await Promise.allSettled(
        batch.map((uid) => startSession({ tenantId: t.id, userId: uid, tenantSlug: t.slug })),
      );
    }
  }
  logger.info({ tenants: tenants.length }, 'wa restoreOnBoot complete');
};
