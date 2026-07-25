// Cross-tenant feedback viewer for the product_owner. Lists every tenant
// user's submitted feedback (5-star + comment), grouped tenant-wise, with the
// user's name / email / phone (phone → "N/A" when absent). PRODUCT_OWNER only.
//
// We fan out across all active tenant DBs (feedback lives per-tenant), query
// each tenant's user_feedback joined to users, and stitch the results together
// with the tenant name resolved from the system DB.
import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { requirePlatformRole } from '../../middleware/rbac.js';
import { PLATFORM_ROLES } from '../../config/constants.js';
import { sysQuery } from '../../db/system.js';
import { resolveTenantById, tenantQuery } from '../../db/tenant.js';
import { logger } from '../../lib/logger.js';

const router = express.Router();
router.use(authRequired, requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER));

// GET /platform/feedback → [{ tenant_id, tenant_slug, tenant_name, count,
//   avg_rating, responses: [{ user_name, email, phone, rating, comment, created_at }] }]
router.get('/', async (req, res, next) => {
  try {
    const { rows: tenants } = await sysQuery(
      `SELECT id, slug, name FROM tenants WHERE status = 'active' AND deleted_at IS NULL ORDER BY name`,
    );

    const groups = [];
    for (const t of tenants) {
      const tenant = await resolveTenantById(t.id);
      if (!tenant) continue;
      let rows = [];
      try {
        ({ rows } = await tenantQuery(
          tenant,
          `SELECT u.name AS user_name, u.email, u.phone, f.rating, f.comment, f.created_at
             FROM user_feedback f
             JOIN users u ON u.id = f.user_id
            ORDER BY f.created_at DESC`,
        ));
      } catch (err) {
        // A tenant whose DB predates the feedback migration just has no table
        // yet — skip it rather than failing the whole cross-tenant view.
        logger.warn({ tenantId: t.id, err: err.message }, 'platform-feedback: tenant query failed');
        continue;
      }
      if (!rows.length) continue;
      const responses = rows.map((r) => ({
        user_name: r.user_name,
        email: r.email,
        phone: r.phone && String(r.phone).trim() ? r.phone : 'N/A',
        rating: r.rating,
        comment: r.comment,
        created_at: r.created_at,
      }));
      const avg = responses.reduce((s, r) => s + r.rating, 0) / responses.length;
      groups.push({
        tenant_id: t.id,
        tenant_slug: t.slug,
        tenant_name: t.name,
        count: responses.length,
        avg_rating: Math.round(avg * 100) / 100,
        responses,
      });
    }

    res.json({ data: groups, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
