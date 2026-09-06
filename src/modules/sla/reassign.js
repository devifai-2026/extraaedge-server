import { tenantQuery } from '../../db/tenant.js';
import { LEAD_OWNER_ROLES } from '../../config/constants.js';

// The SLA action that turns an escalation into an actual reassignment.
// Present in sla_policies.action_json as { "type": "reassign_same_role" }.
export const REASSIGN_SAME_ROLE = 'reassign_same_role';

export const policyReassignsOnEscalation = (policy) =>
  Array.isArray(policy?.action_json)
  && policy.action_json.some((a) => a?.type === REASSIGN_SAME_ROLE);

// Pick a replacement owner for a stale lead, staying inside the CURRENT
// OWNER'S ROLE CLASS: a counsellor's lead goes to another counsellor, a
// telecaller's to another telecaller. The two halves of the front line run
// different playbooks, so a stale lead must never cross between them.
//
// Preference order, applied in one pass:
//   1. same manager  — keeps the lead inside the team that already owns it
//   2. same branch   — keeps it local when the team has nobody else
//   3. least loaded  — fewest OPEN leads, so escalations spread out
//   4. id            — stable tiebreak, so the pick is deterministic
//
// `(x IS DISTINCT FROM y)` is false (sorts first under ASC) when the two
// match, which is what gives tiers 1 and 2 their ordering.
//
// Returns null when there is nobody to hand the lead to — a solo counsellor,
// or an owner whose role can't own leads at all. The caller must treat null as
// "escalate the notification only" and leave the lead where it is; silently
// unassigning it would be worse than a stale owner.
export const pickSameRoleReplacement = async (tenant, currentOwnerId) => {
  if (!currentOwnerId) return null;
  const { rows: [owner] } = await tenantQuery(
    tenant,
    `SELECT id, role, manager_id, branch_id FROM users
      WHERE id = $1 AND deleted_at IS NULL`,
    [currentOwnerId],
  );
  if (!owner || !LEAD_OWNER_ROLES.includes(owner.role)) return null;

  const { rows } = await tenantQuery(
    tenant,
    `SELECT u.id
       FROM users u
       LEFT JOIN leads l
         ON l.assigned_to = u.id AND l.deleted_at IS NULL AND l.converted_at IS NULL
      WHERE u.role = $2
        AND u.is_active = true
        AND u.deleted_at IS NULL
        AND u.id <> $1
      GROUP BY u.id, u.manager_id, u.branch_id
      ORDER BY (u.manager_id IS DISTINCT FROM $3::uuid) ASC,
               (u.branch_id  IS DISTINCT FROM $4::uuid) ASC,
               count(l.id) ASC,
               u.id
      LIMIT 1`,
    [owner.id, owner.role, owner.manager_id, owner.branch_id],
  );
  return rows[0]?.id ?? null;
};
