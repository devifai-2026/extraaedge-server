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

  // ---- Reads that happen to be POSTs ------------------------------------
  // Revealing a masked phone number changes nothing: the handler fetches the
  // lead, writes a 'lead.phone_revealed' audit row and returns the digits. It
  // is a POST only so the reveal is recorded against the person who asked —
  // which is exactly what makes it safe to grant. Blocking it would leave a
  // branch manager able to SEE a lead but never contact them.
  { method: 'POST', re: /^\/leads\/[^/]+\/reveal-phone\/?$/ },

  // Merging duplicate leads. Destructive to one record, but it is cleanup of
  // data that is already wrong, and a branch manager is the person who knows
  // whether two rows are the same human. The survivor keeps every activity,
  // note and payment; the loser is soft-deleted with merged_into_id, so this
  // is reversible in the data even though the UI does not offer an undo.
  { method: 'POST', re: /^\/duplicates\/merge-many\/?$/ },
  { method: 'POST', re: /^\/duplicates\/lead\/[^/]+\/merge\/?$/ },
  { method: 'POST', re: /^\/duplicates\/[^/]+\/ignore\/?$/ },

  // ---- Delegated administration (create + edit, never delete) -----------
  // A branch manager runs a branch: they staff it, they shape the lead
  // pipeline it works, and they schedule the batches it teaches. These three
  // are the only authoring powers the role has, and each is create/update
  // ONLY — DELETE stays with super_admin everywhere below, because removing a
  // user, a stage or a batch destroys history that other branches share.
  //
  // Staff: create a user and edit one. The service layer already constrains a
  // branch_manager actor hard (users/service.js):
  //   • assertBranchManagerScope — the target must be inside their own branch
  //     subtree, and the new reporting manager must be too;
  //   • BRANCH_MANAGER_FORBIDDEN_ROLES — they cannot create, promote into or
  //     edit a super_admin or another branch_manager, so this is not a
  //     privilege-escalation path;
  //   • resolveBranchId — a user created without a branch defaults to the
  //     creator's own.
  // Those guards were written for this role and were simply unreachable while
  // the gate blocked the route. DELETE /users/:id is deliberately absent:
  // offboarding is HR's, and a soft-deleted user takes their lead history off
  // every report.
  { method: 'POST', re: /^\/users\/?$/ },
  { method: 'PUT', re: /^\/users\/[^/]+\/?$/ },

  // Lead stages + sub-stages, and the rest of the dropdown catalogue behind
  // the same routes (sources, statuses, lost reasons...). NOTE this is
  // TENANT-WIDE, not branch-scoped — lead_stages has no branch column, so a
  // stage a branch manager adds or renames appears for every branch in the
  // tenant. That is accepted deliberately; if two branches ever need
  // different pipelines, the table needs a branch_id before this entry can be
  // made safe. Reorder is included because adding a stage without being able
  // to place it in the funnel is not usable.
  { method: 'POST', re: /^\/dropdowns\/[^/]+\/?$/ },
  { method: 'POST', re: /^\/dropdowns\/[^/]+\/reorder\/?$/ },
  { method: 'PUT', re: /^\/dropdowns\/[^/]+\/[^/]+\/?$/ },

  // Batches. These live under /courses/:programId/batches — NOT /classes,
  // which is the live-session + attendance router (a scheduled session of a
  // batch, the trainer's surface). An earlier version of this list allowlisted
  // /classes by mistake, which granted nothing a branch manager actually uses
  // and left every real batch action denied.
  //
  // Create a batch, rename it / set its schedule, place students into it, and
  // merge two batches together:
  { method: 'POST', re: /^\/courses\/[^/]+\/batches\/?$/ },
  { method: 'PUT', re: /^\/courses\/[^/]+\/batches\/[^/]+\/?$/ },
  { method: 'POST', re: /^\/courses\/[^/]+\/batches\/place\/?$/ },
  { method: 'POST', re: /^\/courses\/[^/]+\/batches\/merge\/?$/ },
  // Marking a batch finished is the end of the same scheduling job, not a
  // student record — the per-student completion rows are written by the
  // trainer's own surfaces.
  { method: 'POST', re: /^\/courses\/[^/]+\/batches\/[^/]+\/complete\/?$/ },
  //
  // DELIBERATELY ABSENT:
  //   DELETE /courses/:programId/batches/:batchId — deleting is not granted,
  //     consistent with users and stages above.
  //   /classes/* — the trainer's working surface. A branch manager marking
  //     attendance, firing a question or grading an answer would be authoring
  //     a student record.
  //   /courses/:programId/modules, /trainers, /create-trainer — syllabus and
  //     roster are the head trainer's, not branch scheduling.

  // ---- View-as (read-only by construction) ------------------------------
  // Starting/stopping a look at a staff member's screens. POST only because
  // it writes the audit row that makes the look accountable; the token it
  // returns still carries role: branch_manager, so this gate applies to
  // everything done inside the session too. See modules/view-as/service.js.
  { method: 'POST', re: /^\/view-as\/(start|stop)\/?$/ },

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
