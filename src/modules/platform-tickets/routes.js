// Cross-tenant support inbox for the Product Owner. Reads from system DB
// `support_tickets` (populated when a tenant super_admin raises a ticket;
// see modules/tickets/routes.js). Status/comment changes mirror back into
// the originating tenant DB so the tenant super_admin sees PO replies on
// their own /tickets page.
import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { requirePlatformRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { sysQuery } from '../../db/system.js';
import { resolveTenantById, tenantQuery } from '../../db/tenant.js';
import { notFound } from '../../lib/errors.js';
import { PLATFORM_ROLES } from '../../config/constants.js';

const router = express.Router();
router.use(authRequired, requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER, PLATFORM_ROLES.SUPPORT_ADMIN));

const updateSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
  resolution_note: z.string().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
const commentSchema = z.object({ body: z.string().min(1) });
const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
  tenant_id: z.string().uuid().optional(),
  q: z.string().optional(),
});

router.get('/', validate({ query: listQuery }), async (req, res, next) => {
  try {
    const conds = ['st.deleted_at IS NULL'];
    const params = [];
    if (req.query.status) { params.push(req.query.status); conds.push(`st.status = $${params.length}`); }
    if (req.query.tenant_id) { params.push(req.query.tenant_id); conds.push(`st.tenant_id = $${params.length}`); }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      conds.push(`(st.subject ILIKE $${params.length} OR st.description ILIKE $${params.length} OR st.raised_by_email ILIKE $${params.length})`);
    }
    const { rows } = await sysQuery(
      `SELECT st.*, t.slug AS tenant_slug, t.name AS tenant_name,
              pu.name AS assigned_to_platform_user_name
         FROM support_tickets st
         JOIN tenants t ON t.id = st.tenant_id
         LEFT JOIN platform_users pu ON pu.id = st.assigned_to_platform_user_id
        WHERE ${conds.join(' AND ')}
        ORDER BY st.created_at DESC LIMIT 500`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await sysQuery(
      `SELECT st.*, t.slug AS tenant_slug, t.name AS tenant_name,
              pu.name AS assigned_to_platform_user_name
         FROM support_tickets st
         JOIN tenants t ON t.id = st.tenant_id
         LEFT JOIN platform_users pu ON pu.id = st.assigned_to_platform_user_id
        WHERE st.id = $1 AND st.deleted_at IS NULL`,
      [req.params.id],
    );
    if (!rows[0]) throw notFound('Support ticket not found');
    const { rows: comments } = await sysQuery(
      `SELECT stc.*, pu.name AS platform_user_name
         FROM support_ticket_comments stc
         LEFT JOIN platform_users pu ON pu.id = stc.platform_user_id
        WHERE support_ticket_id = $1
        ORDER BY created_at`,
      [req.params.id],
    );
    res.json({ data: { ...rows[0], comments }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.patch('/:id', validate({ params: idParam, body: updateSchema }), async (req, res, next) => {
  try {
    const { rows: existing } = await sysQuery(
      `SELECT id, tenant_id, tenant_ticket_id FROM support_tickets WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id],
    );
    if (!existing[0]) throw notFound('Support ticket not found');

    const fields = [];
    const params = [];
    let i = 1;
    if (req.body.status !== undefined) {
      fields.push(`status = $${i}`); params.push(req.body.status); i += 1;
      if (req.body.status === 'resolved' || req.body.status === 'closed') {
        fields.push(`resolved_at = COALESCE(resolved_at, now())`);
      } else {
        fields.push(`resolved_at = NULL`);
      }
    }
    if (req.body.resolution_note !== undefined) {
      fields.push(`resolution_note = $${i}`); params.push(req.body.resolution_note); i += 1;
    }
    fields.push(`assigned_to_platform_user_id = COALESCE(assigned_to_platform_user_id, $${i})`);
    params.push(req.user.id); i += 1;
    params.push(req.params.id);
    const { rows } = await sysQuery(
      `UPDATE support_tickets SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      params,
    );
    const updated = rows[0];

    // Mirror the change back into the originating tenant DB so the tenant
    // super_admin sees the PO's update on their own /tickets page. Failures
    // here are logged but don't fail the PO request — the system row is
    // authoritative; the tenant mirror is best-effort and we'll re-sync on
    // next read if needed.
    try {
      const tenant = await resolveTenantById(existing[0].tenant_id);
      if (tenant) {
        const tFields = [];
        const tParams = [];
        let k = 1;
        if (req.body.status !== undefined) {
          tFields.push(`status = $${k}`); tParams.push(req.body.status); k += 1;
          if (req.body.status === 'resolved' || req.body.status === 'closed') {
            tFields.push(`resolved_at = COALESCE(resolved_at, now())`);
          } else {
            tFields.push(`resolved_at = NULL`);
          }
        }
        if (req.body.resolution_note !== undefined) {
          tFields.push(`resolution_note = $${k}`); tParams.push(req.body.resolution_note); k += 1;
        }
        if (tFields.length) {
          tParams.push(existing[0].tenant_ticket_id);
          await tenantQuery(
            tenant,
            `UPDATE tickets SET ${tFields.join(', ')} WHERE id = $${k} AND deleted_at IS NULL`,
            tParams,
          );
        }
      }
    } catch (err) {
      req.log?.warn?.({ err: err.message }, 'platform-ticket mirror to tenant failed');
    }

    res.json({ data: updated, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/:id/comments', validate({ params: idParam, body: commentSchema }), async (req, res, next) => {
  try {
    const { rows: existing } = await sysQuery(
      `SELECT id, tenant_id, tenant_ticket_id FROM support_tickets WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id],
    );
    if (!existing[0]) throw notFound('Support ticket not found');

    const { rows: meRows } = await sysQuery(`SELECT name FROM platform_users WHERE id = $1`, [req.user.id]);
    const { rows: cRows } = await sysQuery(
      `INSERT INTO support_ticket_comments (support_ticket_id, platform_user_id, author_name, body)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, req.user.id, meRows[0]?.name ?? null, req.body.body],
    );

    // Mirror the comment into the tenant ticket thread so the tenant
    // super_admin sees the PO reply. Same best-effort policy as PATCH.
    try {
      const tenant = await resolveTenantById(existing[0].tenant_id);
      if (tenant) {
        await tenantQuery(
          tenant,
          `INSERT INTO ticket_comments (ticket_id, user_id, platform_user_id, body)
           VALUES ($1, NULL, $2, $3)`,
          [existing[0].tenant_ticket_id, req.user.id, req.body.body],
        );
      }
    } catch (err) {
      req.log?.warn?.({ err: err.message }, 'platform-ticket comment mirror to tenant failed');
    }

    res.status(201).json({ data: cRows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
