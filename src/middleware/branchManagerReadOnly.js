import { forbidden } from '../lib/errors.js';
import { SYSTEM_TENANT_ROLES } from '../config/constants.js';
import { verifyToken } from '../lib/jwt.js';

// Branch manager = READ-ONLY, with a short allowlist of approvals.
//
// WHY THIS IS CENTRAL MIDDLEWARE RATHER THAN 189 ROUTE EDITS:
// branch_manager sits in ADMIN_TIER_ROLES and MANAGER_TIER_ROLES, so it
// inherits write access nearly everywhere — and most write routes carry no
// requireRole() of their own at all (leads create/update/delete among them),
// relying on the role groups instead. Editing each one would be a large diff
// with no way to prove completeness, and every NEW write route added later
// would silently grant the role again. A single gate in front of the whole
// tenant API defaults to deny, so anything added in future is restricted
// unless it is explicitly allowlisted here.
//
// The rule: a branch manager may not create, edit, delete, reassign or
// otherwise mutate anything. They approve what counsellors send up, and they
// look at everything.

// Methods that change state. GET/HEAD/OPTIONS always pass.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// The ONLY writes a branch manager may perform. Matched against the path as
// mounted under /api/v1 (see routes.js), so '/lead-discounts/:leadId/decide'
// is written here as a regex over that same path.
//
// Kept deliberately tight — each entry is a decision someone asked for, not a
// convenience:
//   • discount approvals  — the counsellor requests, the BM decides
//   • fee-offer approvals — same shape, same reason
//   • bulk import         — preview/commit and cleaning up failed rows
//   • admission approvals — approving/rejecting what the front line submits
const ALLOWED = [
  // ---- Approvals from counsellors --------------------------------------
  // Decide a pending discount request (approve / reject). NOT POST
  // /lead-discounts/:leadId, which CREATES a discount on a lead.
  { method: 'POST', re: /^\/lead-discounts\/[^/]+\/decide\/?$/ },
  // Negotiated fee offers are a PUT upsert on the lead, not a decide/approve
  // endpoint — setting one is authoring a commercial term, which is exactly
  // the kind of write this role should not have. Deliberately NOT allowlisted.
  // If the business wants BMs to approve fee offers, that needs its own
  // approve/reject endpoint first.
  // NOTE: admission approve/reject is deliberately NOT here. The brief is
  // discount approvals + bulk upload only. The admissions module has its own
  // gate (acctRole) which still lists branch_manager, but this middleware runs
  // first and blocks it — one place to change if that decision is revisited.

  // ---- Bulk write -------------------------------------------------------
  // Bulk lead import: dry-run, commit, retry the rows that failed, and the
  // download/report helpers that are POST only because they take a body.
  { method: 'POST', re: /^\/bulk\/leads\/(preview|commit|download|imports\/[^/]+\/retry-failures)\/?$/ },
  // Bulk admissions import + clearing out failure/duplicate staging rows.
  { method: 'POST', re: /^\/bulk\/admissions\/(preview|commit|failures\/bulk-delete|duplicates\/bulk-delete)\/?$/ },
  // Uploading the spreadsheet itself — bulk upload is useless without it.
  { method: 'POST', re: /^\/uploads\/(presign|confirm)\/?$/ },

  // ---- Their own session / personal state ------------------------------
  // Signing in and out, refreshing a token, changing YOUR OWN password and
  // the clock-in heartbeat are not "write access to the CRM" — blocking them
  // would lock the role out of the product entirely.
  { method: 'POST', re: /^\/auth\// },
  { method: 'POST', re: /^\/work-sessions\// },
  // Marking your own notifications read, and your own notification prefs.
  { method: 'POST', re: /^\/notifications\/(read-all|[^/]+\/read)\/?$/ },
  { method: 'PUT', re: /^\/notification-preferences\/?$/ },
  // Their own leave requests + profile photo, same reasoning.
  { method: 'POST', re: /^\/staff-leave\/(requests|my)\b/ },
  // Raising a support ticket about a problem they can see but not fix.
  { method: 'POST', re: /^\/tickets\/?$/ },
  { method: 'POST', re: /^\/platform-feedback\/?$/ },
];

const isAllowed = (method, path) =>
  ALLOWED.some((a) => a.method === method && a.re.test(path));

// This gate runs at the /api/v1 router, BEFORE each module's own
// authRequired, so req.user does not exist yet. Read the role straight off the
// bearer token instead.
//
// Deliberately fail-open on a bad/absent token: this middleware's job is to
// restrict one role, not to authenticate. An unreadable token simply isn't a
// branch manager as far as we're concerned, and the real authRequired further
// down the stack will reject it a moment later with the proper 401. Throwing
// here would turn every unauthenticated request into the wrong error.
const roleFromRequest = (req) => {
  if (req.user?.role) return req.user.role;
  const h = req.headers?.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  try {
    return verifyToken(h.slice(7))?.role ?? null;
  } catch {
    return null;
  }
};

export const branchManagerReadOnly = (req, _res, next) => {
  if (!WRITE_METHODS.has(req.method)) return next();
  if (roleFromRequest(req) !== SYSTEM_TENANT_ROLES.BRANCH_MANAGER) return next();
  // req.path here is the path WITHIN the /api/v1 router (mountRoutes' `api`),
  // e.g. '/leads/123' — not the full URL.
  if (isAllowed(req.method, req.path)) return next();
  return next(forbidden(
    'Branch managers have read-only access. You can approve discount requests and run bulk uploads — everything else, including creating, editing, reassigning and deleting, is not permitted for this role.',
  ));
};

export default branchManagerReadOnly;
