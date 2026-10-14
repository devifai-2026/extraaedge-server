import { forbidden } from '../lib/errors.js';

// Read-only guard for a branch manager viewing a student's LMS.
//
// A normal student token is untouched by this: it carries no `readOnly` claim,
// so every request falls straight through. Only the token minted by
// student-auth/service.viewAsStudent is affected.
//
// WHY A CENTRAL GATE AND NOT PER-ROUTE CHECKS — the same reasoning as
// branchManagerReadOnly: the student LMS has many write routes (test
// submissions, project uploads, forum posts, feedback, profile edits) and
// none of them carry a check for this today. Listing them individually would
// be a large diff with no way to prove it is complete, and every new student
// write route added later would silently be writable by a viewer. Defaulting
// to deny on write methods means anything added in future is covered without
// anyone remembering to come back here.
//
// There is deliberately NO allowlist. For a branch manager, "support this
// student" means reading their grades, submissions and forum threads — not
// posting, submitting or editing anything. Unlike the staff gate, which has
// to carve out approvals the role genuinely owns, there is no student-side
// write a viewer has any business performing. If one is ever needed, it gets
// added here explicitly and audited, rather than by loosening the default.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const studentReadOnly = (req, _res, next) => {
  if (!WRITE_METHODS.has(req.method)) return next();
  if (req.student?.readOnly !== true) return next();
  return next(forbidden(
    'This is a read-only view of the student account. You can see everything the student sees, but cannot submit, post or change anything on their behalf.',
  ));
};

export default studentReadOnly;
