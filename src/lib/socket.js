// Real-time notification fan-out via socket.io.
//
// Rooms per tenant:
//   tenant:<tenantId>:admins      → all super_admins (also the org-wide bus)
//   tenant:<tenantId>:user:<id>   → that specific user (counsellor / manager)
//   tenant:<tenantId>:manager:<id>→ that specific manager (used to fan team events)
//
// Emit helpers below take care of routing based on event semantics:
//   - notifyUser(userId, ...)        → only that user
//   - notifyManagersOf(userId, ...)  → all managers above that user (1 level + admins)
//   - notifyAdmins(...)              → all super_admins of the tenant
import { Server as IOServer } from 'socket.io';
import { verifyToken } from './jwt.js';
import { logger } from './logger.js';
import { corsOrigins } from '../config/env.js';
import { tenantQuery } from '../db/tenant.js';
import { sysQuery } from '../db/system.js';

let io = null;

const tenantById = async (tenantId) => {
  const { rows } = await sysQuery(
    `SELECT id, slug, status, db_name, db_user, db_password_encrypted FROM tenants WHERE id = $1`,
    [tenantId],
  );
  return rows[0] ?? null;
};

const userRoom    = (tenantId, userId)    => `tenant:${tenantId}:user:${userId}`;
const managerRoom = (tenantId, mgrId)     => `tenant:${tenantId}:manager:${mgrId}`;
const adminRoom   = (tenantId)            => `tenant:${tenantId}:admins`;

export const initSocket = (httpServer) => {
  io = new IOServer(httpServer, {
    cors: {
      origin: (origin, cb) => {
        const allowed = corsOrigins();
        if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
        cb(new Error('CORS_ORIGIN_NOT_ALLOWED'));
      },
      credentials: true,
    },
    path: '/socket.io',
  });

  // Auth handshake — token can come via auth.token or query.token.
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('UNAUTHENTICATED'));
      const claims = verifyToken(token);
      if (claims?.type !== 'access') return next(new Error('INVALID_TOKEN'));
      socket.data.user = {
        id: claims.sub,
        tenantId: claims.tenantId,
        role: claims.role,
      };
      return next();
    } catch (err) {
      return next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket) => {
    const u = socket.data.user;
    if (!u?.tenantId || !u?.id) { socket.disconnect(true); return; }

    // Each socket joins exactly one bus per "audience". `userRoom` covers
    // the personal feed (counsellor or manager); admins additionally subscribe
    // to the tenant-wide admin room. We deliberately don't have a separate
    // managerRoom — every emit that targets managers iterates over their user
    // ids and hits userRoom directly, which keeps fan-out single-shot.
    socket.join(userRoom(u.tenantId, u.id));
    if (u.role === 'super_admin')  socket.join(adminRoom(u.tenantId));

    socket.emit('hello', { ok: true });
    logger.debug({ userId: u.id, tenantId: u.tenantId, role: u.role }, 'socket connected');

    socket.on('disconnect', (reason) => {
      logger.debug({ userId: u.id, reason }, 'socket disconnected');
    });
  });

  return io;
};

export const getIO = () => io;

// ---------- Emit helpers ----------

const wrap = (type, payload) => ({
  type,
  occurred_at: new Date().toISOString(),
  ...payload,
});

// Deliver to exactly one room — the target user's. The admin-room fanout
// for lead-style events is the responsibility of the caller (typically via
// notifyLeadChange → notifyManagersOf or notifyAdmins). Emitting here too
// would deliver the same event twice to super_admins, who are members of
// BOTH userRoom (their own) and adminRoom.
export const notifyUser = (tenantId, userId, type, payload) => {
  if (!io || !tenantId || !userId) return;
  const evt = wrap(type, payload);
  io.to(userRoom(tenantId, userId)).emit('notification', evt);
};

export const notifyManagersOf = async (tenant, userId, type, payload) => {
  if (!io || !tenant?.id || !userId) return;
  try {
    // Pull the user's primary + secondary managers (UNION, deduped). Each
    // socket joins its own user:<id> room on connect, so emitting once to
    // that room is enough — emitting *also* to manager:<id> would deliver
    // the same event twice to the same WebSocket. We deliberately do NOT
    // re-emit to managerRoom for that reason.
    const { rows } = await tenantQuery(
      tenant,
      `SELECT manager_id AS id FROM user_managers WHERE user_id = $1
       UNION
       SELECT manager_id AS id FROM users WHERE id = $1 AND manager_id IS NOT NULL`,
      [userId],
    );
    const evt = wrap(type, payload);
    const seen = new Set();
    for (const r of rows) {
      if (!r.id || seen.has(r.id)) continue;
      seen.add(r.id);
      io.to(userRoom(tenant.id, r.id)).emit('notification', evt);
    }
    io.to(adminRoom(tenant.id)).emit('notification', evt);
  } catch (err) {
    logger.warn({ err: err.message }, 'notifyManagersOf failed');
  }
};

export const notifyAdmins = (tenantId, type, payload) => {
  if (!io || !tenantId) return;
  io.to(adminRoom(tenantId)).emit('notification', wrap(type, payload));
};

// Walk the full manager chain from a user upward (direct manager →
// grand-manager → … → super_admins) and emit to every user room along
// the way. Use when an event needs maximum org-wide oversight, such as
// a counsellor cancelling a scheduled follow-up.
//
// Imports usersRepo lazily to avoid a circular dep at module load.
export const notifyChain = async (tenant, userId, type, payload) => {
  if (!io || !tenant?.id || !userId) return;
  try {
    const { managerChain } = await import('../modules/users/repo.js');
    const ids = await managerChain(tenant, userId);
    const evt = wrap(type, payload);
    const seen = new Set();
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      io.to(userRoom(tenant.id, id)).emit('notification', evt);
    }
    // Admin room delivery covers any super_admin who isn't in `ids`
    // (e.g. tenants where super_admins aren't on the manager_id tree).
    io.to(adminRoom(tenant.id)).emit('notification', evt);
  } catch (err) {
    logger.warn({ err: err.message }, 'notifyChain failed');
  }
};

// Convenience: emit a "lead change" to the right audiences in one call.
//   - the assigned counsellor (so they see new/reassigned leads)
//   - the counsellor's managers (manager chain + admins)
//   - optionally the previous_owner_id and their managers, so a counsellor
//     who just lost a lead also sees the event (UI: "Lead reassigned away
//     from you to <X>"). Admin room is also notified for both sides.
// Pass `actor_id` so you skip emitting back to whoever caused the event.
export const notifyLeadChange = async ({ tenant, lead, type, actor_id, payload = {}, previous_owner_id = null }) => {
  try {
    if (!tenant?.id || !lead?.id) return;
    // Resolve the tenant row if only id was passed (worker context).
    const tenantRow = tenant.db_name ? tenant : await tenantById(tenant.id);
    if (!tenantRow) return;
    const body = { lead_id: lead.id, lead_name: lead.name, actor_id, ...payload };

    // New owner (and their manager chain)
    if (lead.assigned_to && lead.assigned_to !== actor_id) {
      notifyUser(tenantRow.id, lead.assigned_to, type, body);
    }
    if (lead.assigned_to) {
      await notifyManagersOf(tenantRow, lead.assigned_to, type, body);
    } else {
      notifyAdmins(tenantRow.id, type, body);
    }

    // Previous owner (and their manager chain) — only for reassign-style events.
    // Don't double-emit if the previous owner was actually the actor.
    if (previous_owner_id && previous_owner_id !== lead.assigned_to && previous_owner_id !== actor_id) {
      const prevBody = { ...body, lost: true, new_owner_id: lead.assigned_to ?? null };
      notifyUser(tenantRow.id, previous_owner_id, type, prevBody);
      await notifyManagersOf(tenantRow, previous_owner_id, type, prevBody);
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'notifyLeadChange failed');
  }
};
