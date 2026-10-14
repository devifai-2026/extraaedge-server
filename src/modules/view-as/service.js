import { tenantQuery } from '../../db/tenant.js';
import { signAccessToken } from '../../lib/jwt.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES, BRANCH_MANAGER_TAB_KEYS } from '../../config/constants.js';
import { teamHierarchy } from '../users/repo.js';
import { buildAllowedTabs } from '../auth/service.js';
import * as repo from './repo.js';

// "View as" — a branch manager looking at a staff member's screens.
//
// THIS IS NOT IMPERSONATION. The platform's impersonation (modules/
// impersonation) mints a token carrying the TARGET's role, which is how a
// product owner gets to operate a tenant as its super_admin. Doing that here
// would be a privilege-escalation hole the size of the product: a branch
// manager is read-only by design, and a token saying `counsellor` walks
// straight past branchManagerReadOnly — the one gate that makes the role
// read-only at all. They would gain, by viewing a counsellor, every write the
// counsellor has.
//
// So the token this mints keeps `role: branch_manager`. What changes is a
// single added claim, viewAsUserId, which read paths use to narrow the data
// to that one person. The actor is still a branch manager to every gate in
// the stack; they simply see a smaller slice. Read-only is therefore not a
// flag anyone has to remember to check — it is the same middleware that was
// already there, and it cannot be bypassed by this route because this route
// never hands out a different role.
//
// (Compare impersonationReadOnly on the platform side: it is minted into the
// token and then read by nothing — authRequired does not even copy it onto
// req.user. A flag that no middleware enforces is a comment, not a control.
// This module deliberately does not add a second one.)
const VIEW_AS_TTL_SECONDS = 30 * 60;

// Surfaces never lent to a branch manager by a view-as session, whatever the
// target holds. BRANCH_MANAGER_TAB_KEYS omits these deliberately — payroll and
// the Accounts module are real money, and sudo/impersonation is the admin
// escalation path — so borrowing a target's tab list must not re-grant them
// through the back door. Prefix match, so 'payroll' covers 'payroll.runs'.
//
// Everything else the target can see IS lent: the point of the feature is to
// look at the person's actual screens, and the read-only gate (role stays
// branch_manager) is what keeps that look harmless.
const VIEW_AS_NEVER_LEND = Object.freeze([
  'payroll',
  'accounts',
  'payments',
  'impersonation',
  'advanced.users_roles',
]);

// The tabs a view-as token carries: the branch manager's own grant UNION the
// target's, minus the never-lend set above.
//
// UNION rather than the target's alone so the BM keeps their bearings — the
// shell still renders for them — while gaining the target's screens.
const viewAsTabs = (target) => {
  const targetTabs = buildAllowedTabs(target.tab_permissions, target.role) ?? [];
  // A target holding the super_admin wildcard would otherwise expand to
  // everything. loadTargetInBranch already rejects super_admin, so this is a
  // belt-and-braces guard against a custom role seeded with '*'.
  const lendable = (targetTabs.includes('*') ? [] : targetTabs).filter(
    (t) => !VIEW_AS_NEVER_LEND.some((p) => t === p || t.startsWith(`${p}.`)),
  );
  // The never-lend filter applies to BORROWED tabs only. The branch manager's
  // own grant passes through untouched — 'advanced.users_roles' is in
  // BRANCH_MANAGER_TAB_KEYS, and filtering the union would have stripped a
  // surface the role legitimately holds, turning a view-as into a downgrade.
  return [...new Set([...BRANCH_MANAGER_TAB_KEYS, ...lendable])];
};

// Resolve the target and prove they are inside the actor's branch subtree.
//
// teamHierarchy is the same subtree used by listUsers and
// assertBranchManagerScope, so "who may I view" is exactly "who may I manage"
// — one definition of a branch, not a second one that can drift from it.
const loadTargetInBranch = async (tenant, actor, target_user_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT u.id, u.email, u.name, u.role, u.is_active, r.tab_permissions
       FROM users u
       LEFT JOIN custom_roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [target_user_id],
  );
  const target = rows[0];
  if (!target || !target.is_active) throw notFound('User not found');

  // A branch manager may not view another branch manager or a super_admin.
  // Mirrors BRANCH_MANAGER_FORBIDDEN_ROLES in users/service.js: the role does
  // not look sideways at its peers or upward at an admin.
  if (target.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN
      || target.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER) {
    throw forbidden('You cannot view an admin or another branch manager');
  }

  const branch = await teamHierarchy(tenant, actor.id); // actor + subtree
  if (!branch.includes(target.id)) throw forbidden('User is outside your branch');
  return target;
};

export const startViewAs = async ({ tenant, actor, input, ip, user_agent }) => {
  if (actor?.role !== SYSTEM_TENANT_ROLES.BRANCH_MANAGER) {
    throw forbidden('Only a branch manager can use view-as');
  }
  const target = await loadTargetInBranch(tenant, actor, input.target_user_id);

  const session = await repo.startSession(tenant, {
    actor_user_id: actor.id,
    target_user_id: target.id,
    target_user_email: target.email,
    reason: input.reason,
    ip,
    user_agent,
  });

  // NOTE what is and is NOT in these claims:
  //   sub        — still the BRANCH MANAGER. Anything that writes an audit
  //                row, a lead activity or a work session attributes it to the
  //                person who actually did it, never to the person being
  //                viewed.
  //   role       — still branch_manager, so branchManagerReadOnly applies.
  //   allowedTabs— the BM's own tabs UNION the target's, minus the surfaces a
  //                branch manager is deliberately denied (see viewAsTabs).
  //
  //                Originally this was the BM's list alone. That made viewing
  //                a trainer or an HR user useless: BRANCH_MANAGER_TAB_KEYS
  //                contains no trainer.* key at all, so the BM got an empty
  //                shell — the target's data scope rendered through screens
  //                that do not exist for them.
  //
  //                Lending tabs is safe HERE and only here because `role`
  //                below stays branch_manager: a tab controls which screen
  //                renders, branchManagerReadOnly controls whether anything
  //                can be written. The BM sees the trainer's classes and the
  //                HR user's dashboard; every write still returns 403. What
  //                is NOT lent is the money/admin set, because those carry
  //                data the role is denied for a reason, not merely screens
  //                it lacks.
  //   viewAsUserId / viewAsSessionId — the narrowing, and the audit trail.
  const access_token = signAccessToken({
    sub: actor.id,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    email: actor.email,
    role: SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
    allowedTabs: viewAsTabs(target),
    viewAsUserId: target.id,
    viewAsSessionId: session.id,
    // Time spent looking at someone else's queue is not the viewer's own work.
    trackWork: false,
    sessionId: session.id,
    type: 'access',
  }, { ttlSeconds: VIEW_AS_TTL_SECONDS });

  // Deliberately NO refresh token. A view-as session is a look, not a login:
  // it expires in 30 minutes and the branch manager starts a new one, which
  // writes a new audited row. A refreshable view-as session would be an
  // indefinite window into someone's screens with one audit entry at the top.
  return {
    session,
    access_token,
    expires_in: VIEW_AS_TTL_SECONDS,
    target_user: { id: target.id, email: target.email, name: target.name, role: target.role },
  };
};

export const stopViewAs = async ({ tenant, actor }) => {
  const session_id = actor.viewAsSessionId;
  if (!session_id) throw forbidden('Not in a view-as session');
  return repo.endSession(tenant, session_id, actor.id);
};

export const listSessions = async (tenant, query, actor) => {
  // A branch manager sees their OWN view-as history; super_admin sees the
  // tenant's. Nobody else reaches this route (see routes.js).
  const actor_user_id = actor.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN ? null : actor.id;
  return repo.list(tenant, { ...query, actor_user_id });
};
