// Mirrors the linked account's WhatsApp chats/contacts/messages into the tenant
// DB (wa_chats / wa_messages) so the UI can show a full inbox, flagging which
// chats are known CRM leads. Fed by Baileys sync events (messaging-history.set,
// chats.upsert, contacts.upsert) and by live inbound/outbound messages.
//
// All 1:1 chats are matched to a lead by last-10-digits of the phone; groups are
// stored but never lead-matched.
import { logger } from '../lib/logger.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';

const digitsOf = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D+/g, '');
const isGroupJid = (jid) => String(jid || '').endsWith('@g.us');
const is1to1 = (jid) => String(jid || '').endsWith('@s.whatsapp.net');

const matchLeadId = async (tenant, phone) => {
  if (!phone) return null;
  const last10 = phone.length > 10 ? phone.slice(-10) : phone;
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM leads
      WHERE deleted_at IS NULL
        AND (right(regexp_replace(coalesce(whatsapp_number,''), '\\D', '', 'g'), 10) = $1
          OR right(regexp_replace(coalesce(phone,''),           '\\D', '', 'g'), 10) = $1)
      LIMIT 1`,
    [last10],
  );
  return rows[0]?.id ?? null;
};

// Upsert a chat row; returns its id. `name`/`lastBody`/`lastAt` are optional
// hints — we only overwrite when a fresher value is supplied.
export const upsertChat = async (tenantId, ownerUserId, { jid, name, lastBody, lastAt, incUnread = 0 }) => {
  const tenant = await resolveTenantById(tenantId);
  if (!tenant) return null;
  const group = isGroupJid(jid);
  const phone = group ? null : digitsOf(jid);
  const leadId = group ? null : await matchLeadId(tenant, phone);

  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO wa_chats (owner_user_id, wa_jid, phone, name, is_group, lead_id, last_body, last_at, unread)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (owner_user_id, wa_jid) DO UPDATE SET
       name      = COALESCE(EXCLUDED.name, wa_chats.name),
       lead_id   = COALESCE(EXCLUDED.lead_id, wa_chats.lead_id),
       last_body = CASE WHEN EXCLUDED.last_at IS NOT NULL
                         AND (wa_chats.last_at IS NULL OR EXCLUDED.last_at >= wa_chats.last_at)
                        THEN EXCLUDED.last_body ELSE wa_chats.last_body END,
       last_at   = CASE WHEN EXCLUDED.last_at IS NOT NULL
                         AND (wa_chats.last_at IS NULL OR EXCLUDED.last_at >= wa_chats.last_at)
                        THEN EXCLUDED.last_at ELSE wa_chats.last_at END,
       unread    = wa_chats.unread + $9,
       updated_at = now()
     RETURNING id`,
    [ownerUserId, jid, phone, name ?? null, group, leadId, lastBody ?? null, lastAt ?? null, incUnread],
  );
  return rows[0]?.id ?? null;
};

// Insert a message (idempotent on provider_message_id) and roll the chat's
// last_body/last_at forward.
export const insertMessage = async (tenantId, ownerUserId, {
  jid, providerMessageId, direction, body, mediaKey, mediaType, at, name,
}) => {
  const tenant = await resolveTenantById(tenantId);
  if (!tenant) return;
  const chatId = await upsertChat(tenantId, ownerUserId, {
    jid, name,
    lastBody: body || (mediaKey ? '📎 Attachment' : ''),
    lastAt: at,
    incUnread: direction === 'in' ? 1 : 0,
  });
  if (!chatId) return;
  await tenantQuery(
    tenant,
    `INSERT INTO wa_messages
        (chat_id, owner_user_id, provider_message_id, direction, body, media_r2_key, media_type, at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (owner_user_id, provider_message_id) DO NOTHING`,
    [chatId, ownerUserId, providerMessageId ?? null, direction, body ?? '', mediaKey ?? null, mediaType ?? null, at, direction === 'out' ? 'sent' : null],
  ).catch((err) => logger.warn({ tenantId, ownerUserId, err: err.message }, 'wa insertMessage failed'));
};

// Bulk-ingest a Baileys messaging-history.set / chats.upsert payload.
export const ingestChats = async (tenantId, ownerUserId, chats = []) => {
  for (const c of chats) {
    const jid = c.id || c.jid;
    if (!jid || (!is1to1(jid) && !isGroupJid(jid))) continue;
    const lastAt = c.conversationTimestamp
      ? new Date(Number(c.conversationTimestamp) * 1000)
      : null;
    await upsertChat(tenantId, ownerUserId, { jid, name: c.name || c.subject || null, lastAt }).catch(() => {});
  }
};

// Apply contact names (contacts.upsert) onto existing chats.
export const ingestContacts = async (tenantId, ownerUserId, contacts = []) => {
  for (const ct of contacts) {
    const jid = ct.id;
    const name = ct.name || ct.notify || ct.verifiedName;
    if (!jid || !name || !is1to1(jid)) continue;
    await upsertChat(tenantId, ownerUserId, { jid, name }).catch(() => {});
  }
};

export { is1to1, isGroupJid, digitsOf };
