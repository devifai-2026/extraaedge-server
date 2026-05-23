import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import { createLead } from '../leads/service.js';
import { leadCreateSchema } from '../leads/schema.js';
import * as leadsRepo from '../leads/repo.js';
import * as usersRepo from '../users/repo.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// Quick add: same as POST /leads but
//   - on_duplicate='warn' by default (so FE can prompt)
//   - skip_auto_assign=true so the lead lands in the Unassigned bucket
//     (admin/manager assigns manually from the dashboard).
//
// Counsellor exception: when the actor is a counsellor, the lead is
// auto-assigned to them on creation (their own pipeline) and the lead's
// manager_id is forced to the FIRST entry in user_managers — because a
// counsellor may report to multiple managers and the default snapshot
// from users.manager_id only carries one. team_id is snapped from the
// counsellor's own users.team_id so it lands in their team's filter.
//
// Sales-manager exception: lead stays Unassigned (same as admin behaviour
// — they assign manually or rely on round-robin rules), but team_id is
// snapped from the manager's users.team_id so the lead is in scope for
// their dashboard (see computeScope.include_unassigned_team_id).
//
// auto_assign stays off in every branch — quick-add is "Unassigned bucket"
// by design; the existing /leads "Auto-assign unassigned" action covers
// the bulk-route case.
router.post('/', validate({ body: leadCreateSchema }), async (req, res, next) => {
  try {
    const body = { ...req.body };
    const isCounsellor = req.user?.role === SYSTEM_TENANT_ROLES.COUNSELLOR;
    const isSalesManager = req.user?.role === SYSTEM_TENANT_ROLES.SALES_MANAGER;
    let firstManagerId = null;

    if (isCounsellor && !body.assigned_to) {
      body.assigned_to = req.user.id;
      const [managerIds, me] = await Promise.all([
        usersRepo.getManagerIds(req.tenant, req.user.id),
        usersRepo.findById(req.tenant, req.user.id),
      ]);
      firstManagerId = managerIds[0] ?? me?.manager_id ?? null;
      if (!body.team_id && me?.team_id) body.team_id = me.team_id;
    } else if (isSalesManager && !body.team_id) {
      const me = await usersRepo.findById(req.tenant, req.user.id);
      if (me?.team_id) body.team_id = me.team_id;
    }

    const lead = await createLead(req.tenant, req.user, body, {
      on_duplicate: 'warn',
      force: false,
      skip_auto_assign: true,
    });

    // insertLead already snapped manager_id from users.manager_id. If the
    // counsellor's first user_managers entry differs (multi-manager case),
    // overwrite the lead with that one so the LeadCard + manager filters
    // point at the intended primary.
    if (isCounsellor && firstManagerId && lead?.id && lead.manager_id !== firstManagerId) {
      await leadsRepo.setManagerId(req.tenant, lead.id, firstManagerId);
      lead.manager_id = firstManagerId;
    }

    res.status(201).json({ data: lead, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
