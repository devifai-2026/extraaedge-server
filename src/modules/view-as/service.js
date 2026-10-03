import { tenantQuery } from '../../db/tenant.js';
import { signAccessToken } from '../../lib/jwt.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES, BRANCH_MANAGER_TAB_KEYS } from '../../config/constants.js';
import { teamHierarchy } from '../users/repo.js';
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

// Resolve the target and prove they are inside the actor's branch subtree.
//
// teamHierarchy is the same subtree used by listUsers and
// assertBranchManagerScope, so "who may I view" is exactly "who may I manage"
// — one definition of a branch, not a second one that can drift from it.
const loadTargetInBranch = async (tenant, actor, target_user_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, email, name, role, is_active
       FROM users
      WHERE id = $1 AND deleted_at IS NULL`,
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
  //   allowedTabs— the branch manager's own tab list, NOT the target's. A
  //                counsellor holds tabs a branch manager is deliberately
  //                denied (admissions.my_students carries fee offers), and
  //                borrowing the target's list would hand those over.
  //   viewAsUserId / viewAsSessionId — the narrowing, and the audit trail.
  const access_token = signAccessToken({
    sub: actor.id,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    email: actor.email,
    role: SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
    allowedTabs: [...BRANCH_MANAGER_TAB_KEYS],
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
