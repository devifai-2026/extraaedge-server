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
// Why a handover could not happen. Stored on sla_alerts.hold_reason so the
// admin UI can state the actual cause instead of guessing "nobody was free" —
// which was wrong often enough to be misleading.
export const HOLD_REASONS = Object.freeze({
  NO_OWNER: 'no_owner',                 // the alert's owner row is gone
  OWNER_NOT_LEAD_ROLE: 'owner_role',    // owner can no longer hold leads
  NO_PEERS: 'no_peers',                 // nobody else in that role class
  OK: null,
});

// Same as pickSameRoleReplacement but reports WHY when it can't pick.
// Returns { userId, reason } — reason is null on success.
export const pickSameRoleReplacementDetailed = async (tenant, currentOwnerId) => {
  if (!currentOwnerId) return { userId: null, reason: HOLD_REASONS.NO_OWNER };
  const { rows: [owner] } = await tenantQuery(
    tenant,
    `SELECT id, role, manager_id, branch_id FROM users
      WHERE id = $1 AND deleted_at IS NULL`,
    [currentOwnerId],
  );
  if (!owner) return { userId: null, reason: HOLD_REASONS.NO_OWNER };
  if (!LEAD_OWNER_ROLES.includes(owner.role)) {
    return { userId: null, reason: HOLD_REASONS.OWNER_NOT_LEAD_ROLE };
  }
  const userId = await pickSameRoleReplacement(tenant, currentOwnerId);
  return { userId, reason: userId ? HOLD_REASONS.OK : HOLD_REASONS.NO_PEERS };
};

export const pickSameRoleReplacement = async (tenant, currentOwnerId) => {
  if (!currentOwnerId) return null;
  const { rows: [owner] } = await tenantQuery(
    tenant,
    `SELECT id, role, manager_id, branch_id FROM users
      WHERE id = $1 AND deleted_at IS NULL`,
    [currentOwnerId],
  );
  if (!owner || !LEAD_OWNER_ROLES.includes(owner.role)) return null;

  // The open-lead count is recomputed on EVERY call, so a batch of stale
  // leads escalating together spreads as it goes: each handover raises that
  // person's count and the next lead picks whoever is now lowest.
  //
  // This is deliberately a live count rather than a stored cursor. An earlier
  // version took `LIMIT 1` of this ordering, which reads as "least loaded" but
  // collapsed to ONE person for a whole batch: the escalation loop reassigns
  // many leads inside a single tick, and every pick saw the same pre-batch
  // counts. On SpeedUp that sent all 1,036 retried leads to the one counsellor
  // who happened to start the batch lowest (843 open vs ~3,034 for her peers),
  // which is the opposite of the round-robin the rule promises.
  //
  // `tenantQuery` runs each statement on its own connection and the caller
  // awaits the reassignment before the next pick, so the count a later pick
  // sees already includes the earlier ones.
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
