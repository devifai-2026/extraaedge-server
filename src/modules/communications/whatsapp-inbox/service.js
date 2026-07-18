// WhatsApp inbox persistence + tenant routing.
//
// The business WhatsApp number (WABridge/Meta) is SHARED per tenant — not linked
// per user like the old Baileys flow. So all chats for a tenant live under one
// "inbox owner" (the tenant's super_admin), and every staff member with the
// `whatsapp` tab sees the same inbox. Chats/messages reuse the wa_chats /
// wa_messages tables; a chat is flagged with lead_id when its phone matches a
// CRM lead.
import { nanoid } from 'nanoid';
import { logger } from '../../../lib/logger.js';
import { tenantQuery } from '../../../db/tenant.js';
import { putObject, buildKey } from '../../../lib/r2.js';
import { notifyAdmins } from '../../../lib/socket.js';
import { downloadMedia, markRead } from './meta.js';

const digits = (raw) => String(raw ?? '').replace(/\D/g, '');
const normalizePhone = (raw) => {
  const d = digits(raw);
  return d.length === 10 ? `91${d}` : d; // India default, matches WABridge
};
const last10 = (phone) => (phone && phone.length > 10 ? phone.slice(-10) : phone);

// ── per-tenant WhatsApp settings (wa_settings singleton row) ─────
export const getSettings = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT enabled, wabridge_app_key, wabridge_auth_key, wabridge_device_id,
            business_phone, webhook_token, updated_at
       FROM wa_settings WHERE id = true`,
  );
  const r = rows[0] || {};
  return {
    enabled: !!r.enabled,
    appKey: r.wabridge_app_key || '',
    authKey: r.wabridge_auth_key || '',
    deviceId: r.wabridge_device_id || '',
    businessPhone: r.business_phone || '',
    webhookToken: r.webhook_token || '',
    updatedAt: r.updated_at || null,
  };
};

export const saveSettings = async (tenant, input) => {
  // Generate a webhook token on first save if none set.
  const cur = await getSettings(tenant);
  const webhookToken = cur.webhookToken || nanoid(24);
  await tenantQuery(
    tenant,
    `UPDATE wa_settings SET
       enabled = $1, wabridge_app_key = $2, wabridge_auth_key = $3,
       wabridge_device_id = $4, business_phone = $5, webhook_token = $6, updated_at = now()
     WHERE id = true`,
    [
      input.enabled ?? cur.enabled,
      input.appKey ?? cur.appKey,
      input.authKey ?? cur.authKey,
      input.deviceId ?? cur.deviceId,
      input.businessPhone ?? cur.businessPhone,
      webhookToken,
    ],
  );
  return getSettings(tenant);
};

// WABridge credentials object for the send client.
export const credsFor = (settings) => ({ appKey: settings.appKey, authKey: settings.authKey, deviceId: settings.deviceId });

// The shared inbox owner for a tenant = its (first) super_admin.
const ownerCache = new Map(); // tenantId -> userId
export const resolveInboxOwner = async (tenant) => {
  if (ownerCache.has(tenant.id)) return ownerCache.get(tenant.id);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM users WHERE role = 'super_admin' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
  );
  const uid = rows[0]?.id ?? null;
  if (uid) ownerCache.set(tenant.id, uid);
  return uid;
};

const matchLeadId = async (tenant, phone) => {
  const l10 = last10(normalizePhone(phone));
  if (!l10) return null;
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM leads
      WHERE deleted_at IS NULL
        AND (right(regexp_replace(coalesce(whatsapp_number,''), '\\D', '', 'g'), 10) = $1
          OR right(regexp_replace(coalesce(phone,''),           '\\D', '', 'g'), 10) = $1)
      LIMIT 1`,
    [l10],
  );
  return rows[0]?.id ?? null;
};

// For an inbound message: if a lead already matches this number, return it.
// Otherwise create a new lead (marked source=whatsapp) and round-robin it to a
// counsellor (createLead runs applyAssignment for a null actor). Returns the
// lead id, or null if creation failed (message still stored, just unlinked).
const ensureLeadForInbound = async (tenant, phone, senderName) => {
  const existing = await matchLeadId(tenant, phone);
  if (existing) return existing;
  try {
    // Lazy import to avoid a circular dependency (leads/service imports things
    // that could pull this module in).
    const { createLead } = await import('../../leads/service.js');
    const lead = await createLead(
      tenant,
      null, // no actor → tenant-wide round-robin via applyAssignment
      {
        name: senderName || `WhatsApp ${normalizePhone(phone)}`,
        whatsapp_number: normalizePhone(phone),
        phone: normalizePhone(phone),
        first_touch_source: 'whatsapp',
      },
      { on_duplicate: 'warn' }, // we already checked; warn just means don't throw
    );
    return lead?.id ?? null;
  } catch (err) {
    logger.warn({ tenantId: tenant.id, phone, err: err.message }, 'wa: auto lead-create failed');
    return null;
  }
};

// Upsert the chat row for (owner, phone) and roll last message forward.
const upsertChat = async (tenant, ownerId, { phone, name, lastBody, lastAt, incUnread = 0 }) => {
  const leadId = await matchLeadId(tenant, phone);
  const jid = `${phone}@s.whatsapp.net`;
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO wa_chats (owner_user_id, wa_jid, phone, name, is_group, lead_id, last_body, last_at, unread)
     VALUES ($1,$2,$3,$4,false,$5,$6,$7,$8)
     ON CONFLICT (owner_user_id, wa_jid) DO UPDATE SET
       name      = COALESCE(EXCLUDED.name, wa_chats.name),
       lead_id   = COALESCE(EXCLUDED.lead_id, wa_chats.lead_id),
       last_body = CASE WHEN EXCLUDED.last_at IS NOT NULL
                         AND (wa_chats.last_at IS NULL OR EXCLUDED.last_at >= wa_chats.last_at)
                        THEN EXCLUDED.last_body ELSE wa_chats.last_body END,
       last_at   = GREATEST(wa_chats.last_at, EXCLUDED.last_at),
       unread    = wa_chats.unread + $8,
       updated_at = now()
     RETURNING id`,
    [ownerId, jid, phone, name ?? null, leadId, lastBody ?? null, lastAt ?? null, incUnread],
  );
  return { chatId: rows[0]?.id ?? null, leadId };
};

// ── inbound (from the Meta OR WABridge webhook) ─────────────────
// `mediaId` (Meta) → downloaded via the Graph API. `mediaUrl` (WABridge) → the
// media is already hosted at a public URL, fetched directly. Either way the
// bytes land in R2 and the message stores the object key.
export const recordInbound = async ({ tenant, phone, waMessageId, type, text, mediaId, mediaUrl, mimeType, timestamp, senderName }) => {
  const ownerId = await resolveInboxOwner(tenant);
  if (!ownerId) { logger.warn({ tenantId: tenant.id }, 'wa inbox: no super_admin owner'); return; }

  let mediaKey = null;
  let mediaType = null;
  let body = text || '';
  let mediaBytes = null;
  let mediaMime = mimeType || null;
  if (mediaId) {
    const media = await downloadMedia(mediaId);
    if (media?.buffer?.length) { mediaBytes = media.buffer; mediaMime = media.mimeType; }
  } else if (mediaUrl) {
    try {
      const r = await fetch(mediaUrl);
      if (r.ok) { mediaBytes = Buffer.from(await r.arrayBuffer()); mediaMime = r.headers.get('content-type') || mediaMime || 'application/octet-stream'; }
    } catch (e) { logger.warn({ err: e.message }, 'wa inbound media fetch failed'); }
  }
  if (mediaBytes?.length) {
    const ext = ((mediaMime || 'application/octet-stream').split('/')[1] || 'bin').split(';')[0];
    const key = buildKey({ tenantSlug: tenant.slug, purpose: 'whatsapp_inbound', id: nanoid(24), ext });
    await putObject({ key, body: mediaBytes, contentType: mediaMime });
    mediaKey = key;
    mediaType = mediaMime;
    if (!body) body = '📎 Attachment';
  }
  if (!body && !mediaKey) return; // nothing to store

  // Unknown number → create a lead (source=whatsapp) + round-robin it to a
  // counsellor, so the conversation belongs to someone. Existing numbers reuse
  // their lead. Done before upsertChat so the chat links to the lead. Best-
  // effort: a failure here must not drop the inbound message.
  await ensureLeadForInbound(tenant, phone, senderName).catch(() => {});

  const at = timestamp ? new Date(timestamp) : new Date();
  const { chatId } = await upsertChat(tenant, ownerId, {
    phone, name: senderName, lastBody: body, lastAt: at, incUnread: 1,
  });
  if (!chatId) return;

  await tenantQuery(
    tenant,
    `INSERT INTO wa_messages
        (chat_id, owner_user_id, provider_message_id, wa_message_id, direction, body, media_r2_key, media_type, at, status)
     VALUES ($1,$2,$3,$3,'in',$4,$5,$6,$7,NULL)
     ON CONFLICT (owner_user_id, provider_message_id) DO NOTHING`,
    [chatId, ownerId, waMessageId ?? null, body, mediaKey, mediaType ?? (mimeType || null), at],
  );

  // Read receipt back to the customer + live push to the tenant's admins.
  if (waMessageId) markRead(waMessageId).catch(() => {});
  notifyAdmins(tenant.id, 'whatsapp_message', { phone, body, received_at: at.toISOString() });
};

// ── outbound (from the composer, sent via WABridge) ─────────────
export const recordOutbound = async ({ tenant, ownerId, phone, waMessageId, type = 'text', body }) => {
  const owner = ownerId || (await resolveInboxOwner(tenant));
  if (!owner) return null;
  const at = new Date();
  const { chatId } = await upsertChat(tenant, owner, { phone, lastBody: body || `[${type}]`, lastAt: at, incUnread: 0 });
  if (!chatId) return null;
  await tenantQuery(
    tenant,
    `INSERT INTO wa_messages
        (chat_id, owner_user_id, provider_message_id, wa_message_id, direction, body, at, status)
     VALUES ($1,$2,$3,$3,'out',$4, now(), 'sent')
     ON CONFLICT (owner_user_id, provider_message_id) DO NOTHING`,
    [chatId, owner, waMessageId ?? `local-${nanoid(16)}`, body],
  );
  notifyAdmins(tenant.id, 'whatsapp_message', { phone, body, direction: 'out' });
  return chatId;
};

// ── delivery/read status (from the Meta status webhook) ─────────
export const applyStatus = async (tenant, waMessageId, status) => {
  const map = { sent: 'sent', delivered: 'delivered', read: 'seen', failed: 'failed' };
  const s = map[status];
  if (!s) return;
  await tenantQuery(
    tenant,
    `UPDATE wa_messages SET status = $2 WHERE wa_message_id = $1`,
    [waMessageId, s],
  ).catch(() => {});
  notifyAdmins(tenant.id, 'whatsapp_status', { wa_message_id: waMessageId, status: s });
};

// ── role-based visibility ───────────────────────────────────────
// WhatsApp visibility follows the LINKED LEAD's owner + the same role scoping as
// the leads list (reusing computeScope). Returns { where, params } fragments to
// splice into a query aliasing wa_chats as `c` and leads as `l`.
//   super_admin / account_manager → all chats (incl. unlinked)
//   branch_manager                → chats whose lead is in their branch
//   sales_manager                 → chats whose lead is assigned to their team
//   counsellor                    → chats whose lead is assigned to them
// Chats with no linked lead are visible ONLY to all-access roles.
const ALL_ACCESS_ROLES = new Set(['super_admin', 'account_manager']);
// Mirrors leads/service.computeScope (which is module-private) so WhatsApp
// visibility exactly matches lead visibility. Returns a WHERE fragment over
// leads `l` + its params, starting bind indexes at startIdx.
const waScope = async (tenant, actor, startIdx = 1) => {
  if (!actor?.role) return { where: 'false', params: [] };
  if (ALL_ACCESS_ROLES.has(actor.role)) return { where: 'true', params: [] };

  const p = [];
  let i = startIdx;

  if (actor.role === 'branch_manager') {
    const { findById } = await import('../../users/repo.js');
    const me = await findById(tenant, actor.id);
    p.push(me?.branch_id ?? '00000000-0000-0000-0000-000000000000');
    return { where: `l.branch_id = $${i}`, params: p };
  }

  if (actor.role === 'sales_manager') {
    const [{ teamHierarchy, findById }] = await Promise.all([import('../../users/repo.js')]);
    const ids = await teamHierarchy(tenant, actor.id);
    const me = await findById(tenant, actor.id);
    p.push(ids && ids.length ? ids : [actor.id]);
    const uidClause = `l.assigned_to = ANY($${i}::uuid[])`;
    i += 1;
    if (me?.team_id) {
      p.push(me.team_id);
      return { where: `(${uidClause} OR (l.assigned_to IS NULL AND l.team_id = $${i}))`, params: p };
    }
    return { where: uidClause, params: p };
  }

  // counsellor (and any other tenant role): only leads assigned to me.
  p.push(actor.id);
  return { where: `l.assigned_to = $${i}`, params: p };
};

// ── read model (actor/role-scoped) ──────────────────────────────
export const listChats = async (tenant, actor) => {
  const sc = await waScope(tenant, actor, 1);
  // Non-all-access roles only see chats that HAVE a linked lead in scope.
  const linkedOnly = !ALL_ACCESS_ROLES.has(actor?.role);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT c.id, c.phone, c.is_group, c.last_body, c.last_at, c.unread,
            COALESCE(l.name, c.name, c.phone) AS name,
            c.lead_id, l.name AS lead_name, l.assigned_to AS lead_owner_id,
            ao.name AS lead_owner_name
       FROM wa_chats c
       LEFT JOIN leads l ON l.id = c.lead_id AND l.deleted_at IS NULL
       LEFT JOIN users ao ON ao.id = l.assigned_to
      WHERE c.is_group = false
        AND ${linkedOnly ? 'c.lead_id IS NOT NULL AND' : ''} (${sc.where})
      ORDER BY c.last_at DESC NULLS LAST
      LIMIT 500`,
    sc.params,
  );
  return rows;
};

export const listMessages = async (tenant, actor, phone) => {
  const norm = normalizePhone(phone);
  const sc = await waScope(tenant, actor, 2);
  const linkedOnly = !ALL_ACCESS_ROLES.has(actor?.role);
  // Resolve the chat within the caller's scope (phone + role predicate).
  const { rows: [chat] } = await tenantQuery(
    tenant,
    `SELECT c.id
       FROM wa_chats c
       LEFT JOIN leads l ON l.id = c.lead_id AND l.deleted_at IS NULL
      WHERE c.phone = $1
        AND ${linkedOnly ? 'c.lead_id IS NOT NULL AND' : ''} (${sc.where})
      LIMIT 1`,
    [norm, ...sc.params],
  );
  if (!chat) return [];
  // Messages are stored under one owner key; scope is enforced at the chat level
  // above, so here we fetch by chat_id.
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, direction, body, media_r2_key,
            CASE WHEN media_r2_key IS NULL THEN NULL ELSE ARRAY[media_r2_key] END AS media_keys,
            media_type, at, status, wa_message_id AS provider_message_id
       FROM wa_messages WHERE chat_id = $1
      ORDER BY at ASC LIMIT 500`,
    [chat.id],
  );
  await tenantQuery(tenant, `UPDATE wa_chats SET unread = 0 WHERE id = $1`, [chat.id]).catch(() => {});
  return rows;
};

// Resolve a chat the actor is allowed to act on (for send/read), by phone.
export const resolveChatForActor = async (tenant, actor, phone) => {
  const norm = normalizePhone(phone);
  const sc = await waScope(tenant, actor, 2);
  const linkedOnly = !ALL_ACCESS_ROLES.has(actor?.role);
  const { rows: [chat] } = await tenantQuery(
    tenant,
    `SELECT c.id, c.phone
       FROM wa_chats c
       LEFT JOIN leads l ON l.id = c.lead_id AND l.deleted_at IS NULL
      WHERE c.phone = $1
        AND ${linkedOnly ? 'c.lead_id IS NOT NULL AND' : ''} (${sc.where})
      LIMIT 1`,
    [norm, ...sc.params],
  );
  return chat || null;
};

export const markChatRead = async (tenant, actor, phone) => {
  const chat = await resolveChatForActor(tenant, actor, phone);
  if (!chat) return;
  await tenantQuery(tenant, `UPDATE wa_chats SET unread = 0 WHERE id = $1`, [chat.id]).catch(() => {});
};

// ── local templates (wa_templates) ──────────────────────────────
export const listTemplates = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, template_id, label, body, variable_count, category, created_at
       FROM wa_templates ORDER BY created_at DESC`,
  );
  return rows;
};

export const addTemplate = async (tenant, { template_id, label, body, category }, userId) => {
  const variableCount = (String(body || '').match(/\{\{\d+\}\}/g) || []).length;
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO wa_templates (template_id, label, body, variable_count, category, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (template_id) DO UPDATE SET
       label = EXCLUDED.label, body = EXCLUDED.body,
       variable_count = EXCLUDED.variable_count, category = EXCLUDED.category
     RETURNING id, template_id, label, body, variable_count, category, created_at`,
    [String(template_id).trim(), label.trim(), body, variableCount, category || null, userId || null],
  );
  return rows[0];
};

export const deleteTemplate = async (tenant, id) => {
  await tenantQuery(tenant, `DELETE FROM wa_templates WHERE id = $1`, [id]);
};

export { normalizePhone, last10, digits };
