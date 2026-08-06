import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

const router = express.Router();
// Read routes below (GET / and GET /summary) are gated super_admin-only
// per-route, not here — POST /events must stay reachable by every
// authenticated tenant user so the frontend can log its OWN copy/blur/
// devtools events (see DataProtection/securityEvents.js).
router.use(authRequired, tenantRequired);

const query = z.object({
  entity_type: z.string().optional(),
  entity_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  action: z.string().optional(),
  date_from: z.coerce.date().optional(),
  date_to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

router.get('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ query }), async (req, res, next) => {
  try {
    const conds = [];
    const params = [];
    if (req.query.entity_type) { params.push(req.query.entity_type); conds.push(`entity_type = $${params.length}`); }
    if (req.query.entity_id) { params.push(req.query.entity_id); conds.push(`entity_id = $${params.length}`); }
    if (req.query.user_id) { params.push(req.query.user_id); conds.push(`user_id = $${params.length}`); }
    if (req.query.action) { params.push(req.query.action); conds.push(`action = $${params.length}`); }
    if (req.query.date_from) { params.push(req.query.date_from); conds.push(`created_at >= $${params.length}`); }
    if (req.query.date_to) { params.push(req.query.date_to); conds.push(`created_at <= $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id, page: req.query.page, limit: req.query.limit } });
  } catch (err) { next(err); }
});

const summaryQuery = z.object({
  action: z.string().default('lead.phone_revealed'),
  hours: z.coerce.number().int().min(1).max(720).default(24),
  // Above this count in the window, a user is flagged — scraping/leak-prep
  // pattern, not normal call-prep behavior.
  threshold: z.coerce.number().int().min(1).default(30),
});

// Per-user counts of a given action in a rolling window, flagged once over
// threshold — the "who's revealing way more numbers than normal" view.
router.get('/summary', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ query: summaryQuery }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT a.user_id, u.name AS user_name, u.role AS user_role, count(*)::int AS event_count
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.action = $1 AND a.created_at > now() - ($2::int * interval '1 hour')
        GROUP BY a.user_id, u.name, u.role
        ORDER BY event_count DESC`,
      [req.query.action, req.query.hours],
    );
    const flagged = rows.filter((r) => r.event_count > req.query.threshold);
    res.json({ data: rows, meta: { requestId: req.id, threshold: req.query.threshold, flagged_user_ids: flagged.map((r) => r.user_id) } });
  } catch (err) { next(err); }
});

// Client-reported security events — copy/right-click attempts, window blur
// while lead data was on screen, a devtools-open heuristic firing. Any
// authenticated tenant user can log their OWN events; the action allowlist
// keeps this endpoint from becoming a free-form log injection point.
const CLIENT_ACTIONS = [
  'lead.copy_attempt',
  'lead.contextmenu_attempt',
  'lead.window_blur',
  'lead.devtools_suspected',
];

const eventBody = z.object({
  action: z.enum(CLIENT_ACTIONS),
  entity_type: z.string().max(40).optional(),
  entity_id: z.string().uuid().optional(),
});

router.post('/events', validate({ body: eventBody }), async (req, res, next) => {
  try {
    await writeAuditLog(req.tenant, {
      userId: req.user.id,
      action: req.body.action,
      entityType: req.body.entity_type,
      entityId: req.body.entity_id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(201).json({ data: { ok: true }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
