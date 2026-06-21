import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import { createLead } from '../leads/service.js';
import { leadCreateSchema } from '../leads/schema.js';
import * as leadsRepo from '../leads/repo.js';
import * as usersRepo from '../users/repo.js';
import { SYSTEM_TENANT_ROLES, TEAM_SCOPED_MANAGER_ROLES } from '../../config/constants.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// Quick add: same as POST /leads but
//   - on_duplicate='warn' by default (so FE can prompt)
//   - skip_auto_assign=true so the lead never goes through round-robin here.
//
// Owner-bucket rule (per product spec): the lead lands in the adding user's
// OWN bucket ONLY when a counsellor adds it. Every elevated role leaves it
// Unassigned and then runs the "Auto-assign unassigned" action to round-robin
// it onto a counsellor.
//   - counsellor:    self-assigned. manager_id is forced to the FIRST entry in
//                    user_managers (a counsellor may report to multiple
//                    managers and the users.manager_id snapshot carries only
//                    one). team_id is snapped from their users.team_id.
//   - sales_manager /
//     branch_manager: lead stays UNASSIGNED (they assign manually or rely on
//                    round-robin), but team_id is snapped from their
//                    users.team_id so the unassigned lead is in scope for their
//                    (branch) dashboard (computeScope.include_unassigned_team_id).
//   - super_admin:   lead stays UNASSIGNED with no team stamp.
//
// auto_assign stays off in every branch — the existing /leads
// "Auto-assign unassigned" action covers the round-robin case.
router.post('/', validate({ body: leadCreateSchema }), async (req, res, next) => {
  try {
    const body = { ...req.body };
    const isCounsellor = req.user?.role === SYSTEM_TENANT_ROLES.COUNSELLOR;
    // sales_manager + branch_manager both leave the quick-add Unassigned but
    // stamp their own team_id (legacy sales_manager scope) AND their branch_id
    // (branch_manager scope) so it surfaces in their bucket.
    const isManager = TEAM_SCOPED_MANAGER_ROLES.includes(req.user?.role);
    let firstManagerId = null;
    // Branch to stamp on the unassigned manager quick-add (null for counsellor
    // — insertLead snaps the counsellor's branch from their own assignee row).
    let managerBranchId = null;

    if (isCounsellor && !body.assigned_to) {
      body.assigned_to = req.user.id;
      const [managerIds, me] = await Promise.all([
        usersRepo.getManagerIds(req.tenant, req.user.id),
        usersRepo.findById(req.tenant, req.user.id),
      ]);
      firstManagerId = managerIds[0] ?? me?.manager_id ?? null;
      if (!body.team_id && me?.team_id) body.team_id = me.team_id;
    } else if (isManager) {
      // sales_manager / branch_manager: leave Unassigned but stamp team_id +
      // branch_id so it surfaces in their (branch) Unassigned bucket.
      const me = await usersRepo.findById(req.tenant, req.user.id);
      if (!body.team_id && me?.team_id) body.team_id = me.team_id;
      managerBranchId = me?.branch_id ?? null;
    }

    const lead = await createLead(req.tenant, req.user, body, {
      on_duplicate: 'warn',
      force: false,
      skip_auto_assign: true,
    });

    // insertLead already snapped manager_id from users.manager_id. For a
    // self-assigning counsellor whose first user_managers entry differs
    // (multi-manager case), overwrite with that one so the LeadCard +
    // manager filters point at the intended primary.
    if (isCounsellor && firstManagerId && lead?.id && lead.manager_id !== firstManagerId) {
      await leadsRepo.setManagerId(req.tenant, lead.id, firstManagerId);
      lead.manager_id = firstManagerId;
    }
    // Manager's unassigned quick-add: no assignee to snap branch from, so
    // stamp the manager's own branch explicitly.
    if (isManager && managerBranchId && lead?.id && !lead.branch_id) {
      await leadsRepo.setBranchId(req.tenant, lead.id, managerBranchId);
      lead.branch_id = managerBranchId;
    }

    res.status(201).json({ data: lead, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
