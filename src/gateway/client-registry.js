// Singleton in-memory registry of whatsapp-web.js Client instances.
//
// Why a singleton process (not a BullMQ worker pool): a Client is a STATEFUL,
// long-lived headless Chromium bound to one process's memory. Only the process
// holding user X's live Client can send for X — so we own all Clients here in a
// Map keyed by `${tenantId}:${userId}` and the API addresses us directly over
// internal HTTP.
//
// Each Client's async events (qr / ready / disconnected / inbound message /
// ack) update the tenant DB and are pushed to the owning user's browser via
// notify-api → API socket.io.
import path from 'node:path';
import os from 'node:os';
import pkg from 'whatsapp-web.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { GcsStore, sessionGcsKey } from './remote-auth-gcs.js';
import { notifyApi } from './notify-api.js';

const { Client, RemoteAuth } = pkg;

// key -> { client, status, phone, tenantId, userId, tenantSlug, lastQr, readyAt }
const clients = new Map();

const keyOf = (tenantId, userId) => `${tenantId}:${userId}`;
// RemoteAuth clientId must be [A-Za-z0-9_-] only; ':' is not allowed.
const clientIdOf = (tenantId, userId) => `${tenantId}__${userId}`;

// All RemoteAuth zips stage under one working dir, outside the project source.
const DATA_PATH = path.join(os.tmpdir(), 'wwebjs_auth');

// ---- per-Client event wiring ----

const wireEvents = (entry) => {
  const { client, tenantId, userId } = entry;

  client.on('qr', async (qr) => {
    entry.status = 'pending_qr';
    entry.lastQr = qr;
    await updateSessionStatus(tenantId, userId, { status: 'pending_qr', last_qr_at: 'now()' });
    notifyApi(tenantId, userId, 'whatsapp_qr', { qr });
  });

  client.on('ready', async () => {
    entry.status = 'connected';
    entry.readyAt = Date.now();
    const phone = client.info?.wid?.user ?? null;
    entry.phone = phone;
    await updateSessionStatus(tenantId, userId, {
      status: 'connected',
      phone,
      connected_at: 'now()',
      last_seen_at: 'now()',
    });
    notifyApi(tenantId, userId, 'whatsapp_ready', { phone });
    logger.info({ tenantId, userId, phone }, 'wa client ready');
  });

  client.on('authenticated', () => {
    logger.debug({ tenantId, userId }, 'wa client authenticated');
  });

  client.on('auth_failure', async (msg) => {
    entry.status = 'disconnected';
    await updateSessionStatus(tenantId, userId, { status: 'disconnected' });
    notifyApi(tenantId, userId, 'whatsapp_disconnected', { reason: 'auth_failure', detail: msg });
    logger.warn({ tenantId, userId, msg }, 'wa auth_failure');
  });

  client.on('disconnected', async (reason) => {
    entry.status = 'disconnected';
    await updateSessionStatus(tenantId, userId, { status: 'disconnected' });
    notifyApi(tenantId, userId, 'whatsapp_disconnected', { reason: String(reason) });
    // Keep the GCS blob so /connect can restore without a fresh QR.
    clients.delete(keyOf(tenantId, userId));
    logger.warn({ tenantId, userId, reason }, 'wa client disconnected');
  });

  // Inbound message → match lead by phone, store reply, notify the owning user.
  client.on('message', async (msg) => {
    try {
      if (msg.fromMe) return;
      const tenant = await resolveTenantById(tenantId);
      if (!tenant) return;
      // msg.from is like "<number>@c.us" for 1:1 chats; ignore groups/status.
      if (!msg.from?.endsWith('@c.us')) return;
      const fromNumber = msg.from.replace('@c.us', '');
      const last10 = fromNumber.length > 10 ? fromNumber.slice(-10) : fromNumber;

      const { rows: matched } = await tenantQuery(
        tenant,
        `SELECT id FROM leads
          WHERE deleted_at IS NULL
            AND right(regexp_replace(coalesce(whatsapp_number,''), '\\D', '', 'g'), 10) = $1
             OR right(regexp_replace(coalesce(phone,''),           '\\D', '', 'g'), 10) = $1
          LIMIT 1`,
        [last10],
      );
      const leadId = matched[0]?.id ?? null;
      const { rows: sess } = await tenantQuery(
        tenant,
        `SELECT id FROM user_whatsapp_sessions WHERE user_id = $1`,
        [userId],
      );
      await tenantQuery(
        tenant,
        `INSERT INTO message_reply
            (lead_id, channel, provider_message_id, body, received_at, routed_to_user_id, user_whatsapp_session_id)
         VALUES ($1,'whatsapp',$2,$3, now(), $4, $5)`,
        [leadId, msg.id?._serialized ?? msg.id?.id ?? null, msg.body ?? '', userId, sess[0]?.id ?? null],
      );
      notifyApi(tenantId, userId, 'whatsapp_message', {
        lead_id: leadId,
        from: fromNumber,
        body: msg.body ?? '',
        received_at: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn({ tenantId, userId, err: err.message }, 'wa inbound message handling failed');
    }
  });

  // Delivery acks: 1=sent, 2=delivered, 3=read.
  client.on('message_ack', async (msg, ack) => {
    try {
      const map = { 1: 'sent', 2: 'delivered', 3: 'seen' };
      const status = map[ack];
      if (!status) return;
      const tenant = await resolveTenantById(tenantId);
      if (!tenant) return;
      const providerMessageId = msg.id?._serialized ?? msg.id?.id ?? null;
      if (!providerMessageId) return;
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
      logger.warn({ tenantId, userId, err: err.message }, 'wa ack handling failed');
    }
  });
};

// updateSessionStatus accepts either literal values or the string 'now()' to
// set a timestamp to the DB clock. We build the SQL dynamically so 'now()' is
// emitted unparameterized while everything else is a bound param.
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

// ---- public API ----

export const startSession = async ({ tenantId, userId, tenantSlug }) => {
  const key = keyOf(tenantId, userId);
  const existing = clients.get(key);
  if (existing && (existing.status === 'pending_qr' || existing.status === 'connected')) {
    return { status: existing.status, phone: existing.phone ?? null };
  }

  // Resolve slug if the caller didn't pass it (boot-restore passes it).
  let slug = tenantSlug;
  if (!slug) {
    const tenant = await resolveTenantById(tenantId);
    slug = tenant?.slug;
  }

  const store = new GcsStore({ dataPath: DATA_PATH, tenantSlug: slug });
  const client = new Client({
    authStrategy: new RemoteAuth({
      clientId: clientIdOf(tenantId, userId),
      dataPath: DATA_PATH,
      store,
      backupSyncIntervalMs: 5 * 60_000,
    }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      ...(env.WA_PUPPETEER_EXECUTABLE_PATH ? { executablePath: env.WA_PUPPETEER_EXECUTABLE_PATH } : {}),
    },
  });

  const entry = { client, status: 'initializing', phone: null, tenantId, userId, tenantSlug: slug, lastQr: null, readyAt: null };
  clients.set(key, entry);
  wireEvents(entry);

  // Stamp the GCS key we'll persist under so the DB row is self-describing.
  await updateSessionStatus(tenantId, userId, {
    session_gcs_key: sessionGcsKey(slug, `RemoteAuth-${clientIdOf(tenantId, userId)}`),
  });

  client.initialize().catch((err) => {
    logger.error({ tenantId, userId, err: err.message }, 'wa client.initialize failed');
    clients.delete(key);
  });

  return { status: 'initializing' };
};

export const getStatus = (tenantId, userId) => {
  const entry = clients.get(keyOf(tenantId, userId));
  if (!entry) return { status: 'not_loaded', phone: null };
  return { status: entry.status, phone: entry.phone ?? null };
};

export const send = async ({ tenantId, userId, to, body }) => {
  const entry = clients.get(keyOf(tenantId, userId));
  if (!entry || entry.status !== 'connected') {
    const err = new Error('NOT_CONNECTED');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  // Normalize recipient to whatsapp-web.js chat id. Strip non-digits; the lib
  // wants "<countrycode><number>@c.us". Callers pass E.164-ish strings.
  const digits = String(to).replace(/\D+/g, '');
  const chatId = `${digits}@c.us`;
  const sent = await entry.client.sendMessage(chatId, body);
  return { provider_message_id: sent.id?._serialized ?? sent.id?.id ?? null, status: 'sent' };
};

export const logout = async (tenantId, userId) => {
  const key = keyOf(tenantId, userId);
  const entry = clients.get(key);
  if (entry) {
    try { await entry.client.logout(); } catch { /* device may already be gone */ }
    try { await entry.client.destroy(); } catch { /* ignore */ }
    clients.delete(key);
  }
  await updateSessionStatus(tenantId, userId, { status: 'logged_out', phone: null });
  return { ok: true };
};

export const clientCount = () => clients.size;

export const destroyAll = async () => {
  await Promise.allSettled([...clients.values()].map((e) => e.client.destroy()));
  clients.clear();
};

// Re-link every previously-connected session from GCS on boot, throttled so we
// don't fork N Chromium processes at once. RemoteAuth restores without a QR.
export const restoreOnBoot = async () => {
  const { sysQuery } = await import('../db/system.js');
  const { rows: tenants } = await sysQuery(
    `SELECT id, slug FROM tenants WHERE status = 'active' AND deleted_at IS NULL`,
  );
  const concurrency = Math.max(1, env.WA_SESSION_RESTORE_CONCURRENCY);
  for (const t of tenants) {
    let rows = [];
    try {
      const tenant = await resolveTenantById(t.id);
      const res = await tenantQuery(tenant, `SELECT user_id FROM user_whatsapp_sessions WHERE status = 'connected'`);
      rows = res.rows;
    } catch (err) {
      logger.warn({ tenantId: t.id, err: err.message }, 'wa restore: tenant query failed');
      continue;
    }
    for (let i = 0; i < rows.length; i += concurrency) {
      const batch = rows.slice(i, i + concurrency);
      await Promise.allSettled(
        batch.map((r) => startSession({ tenantId: t.id, userId: r.user_id, tenantSlug: t.slug })),
      );
    }
  }
  logger.info({ tenants: tenants.length }, 'wa restoreOnBoot complete');
};
