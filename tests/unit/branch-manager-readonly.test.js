import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchManagerReadOnly } from '../../src/middleware/branchManagerReadOnly.js';
import { signAccessToken } from '../../src/lib/jwt.js';
import { SYSTEM_TENANT_ROLES } from '../../src/config/constants.js';

// This middleware is the ONLY thing making branch_manager read-only: the role
// sits in ADMIN_TIER_ROLES and MANAGER_TIER_ROLES, and most write routes carry
// no requireRole() of their own. A regex typo here silently grants or revokes
// a surface across the whole tenant API, which is exactly the kind of mistake
// nothing else in the stack would catch.

// Drives the real middleware rather than re-deriving its allowlist, so a test
// cannot pass against a copy of the rules that has drifted from the shipped
// ones. Returns true when the request was allowed through.
const allows = (method, path, role = SYSTEM_TENANT_ROLES.BRANCH_MANAGER) => {
  const req = {
    method,
    path,
    user: role ? { role } : undefined,
    headers: {},
  };
  let passed = false;
  let err = null;
  branchManagerReadOnly(req, {}, (e) => { if (e) err = e; else passed = true; });
  if (err) {
    assert.equal(err.status ?? err.statusCode, 403, `expected a 403 for ${method} ${path}`);
    return false;
  }
  return passed;
};

test('reads are never blocked', () => {
  for (const p of ['/leads', '/admissions/abc', '/payments', '/users']) {
    assert.ok(allows('GET', p), `GET ${p} should pass`);
    assert.ok(allows('HEAD', p), `HEAD ${p} should pass`);
  }
});

test('other roles are untouched by this gate', () => {
  // The middleware must be a no-op for everyone else, including on the paths
  // it blocks for a branch manager.
  for (const role of ['super_admin', 'counsellor', 'sales_manager', 'account_manager']) {
    assert.ok(allows('DELETE', '/leads/abc', role), `${role} should not be gated`);
    assert.ok(allows('POST', '/admissions', role), `${role} should not be gated`);
  }
});

test('an unreadable token fails OPEN — authRequired rejects it later', () => {
  // Deliberate: this middleware restricts one role, it does not authenticate.
  // Throwing here would turn every unauthenticated request into the wrong error.
  assert.ok(allows('POST', '/leads', null));
});

test('the role is read off the bearer token before authRequired runs', () => {
  // This gate is mounted at the /api/v1 router, ahead of each module's own
  // authRequired, so req.user does not exist yet on a real request.
  const token = signAccessToken({
    sub: 'u1', role: SYSTEM_TENANT_ROLES.BRANCH_MANAGER, type: 'access',
  });
  const req = { method: 'POST', path: '/leads', headers: { authorization: `Bearer ${token}` } };
  let err = null;
  branchManagerReadOnly(req, {}, (e) => { err = e; });
  assert.ok(err, 'a branch_manager token alone must be enough to block the write');
  assert.equal(err.status ?? err.statusCode, 403);
});

test('core CRM writes stay blocked', () => {
  const blocked = [
    ['POST', '/leads'], ['PUT', '/leads/abc'], ['DELETE', '/leads/abc'],
    ['POST', '/lead-assignments'],          // reassignment — the SpeedUp incident
    ['POST', '/lead-discounts/abc'],        // CREATING a discount, not deciding one
    ['PUT', '/lead-fee-offers/abc'],        // authoring a commercial term
    ['POST', '/admissions'], ['PUT', '/admissions/abc'],
    ['POST', '/admissions/centers'],
    ['POST', '/payments'],
  ];
  for (const [m, p] of blocked) assert.equal(allows(m, p), false, `${m} ${p} must be blocked`);
});

test('approvals + bulk import + own session are allowed', () => {
  const ok = [
    ['POST', '/lead-discounts/abc/decide'],
    ['POST', '/leads/abc/reveal-phone'],
    ['POST', '/duplicates/merge-many'],
    ['POST', '/bulk/leads/commit'],
    ['POST', '/uploads/presign'],
    ['POST', '/auth/login'],
    ['POST', '/work-sessions/heartbeat'],
  ];
  for (const [m, p] of ok) assert.ok(allows(m, p), `${m} ${p} should be allowed`);
});

// ---- Delegated administration: create + edit, never delete ----------------

test('delegated admin — create and edit are allowed', () => {
  const ok = [
    ['POST', '/users'], ['PUT', '/users/abc-123'],
    ['POST', '/dropdowns/stages'], ['POST', '/dropdowns/sub-stages'],
    ['PUT', '/dropdowns/stages/abc-123'], ['POST', '/dropdowns/stages/reorder'],
    // Batches live under /courses/:programId/batches, NOT /classes.
    ['POST', '/courses/p1/batches'], ['PUT', '/courses/p1/batches/b1'],
    ['POST', '/courses/p1/batches/place'], ['POST', '/courses/p1/batches/merge'],
    ['POST', '/courses/p1/batches/b1/complete'],
  ];
  for (const [m, p] of ok) assert.ok(allows(m, p), `${m} ${p} should be allowed`);
});

test('delegated admin — DELETE is never granted', () => {
  // Removing a user, a stage or a batch destroys history other branches share.
  for (const p of ['/users/abc', '/dropdowns/stages/abc', '/courses/p1/batches/b1']) {
    assert.equal(allows('DELETE', p), false, `DELETE ${p} must stay blocked`);
  }
});

test('batch grant does not leak the trainer working surface', () => {
  // Batch scheduling is /courses/:programId/batches. The ENTIRE /classes
  // router is the trainer's surface (a class is a live session of a batch) —
  // attendance, grading, lifecycle and the question bank. A branch manager
  // marking attendance would be authoring a student record.
  const blocked = [
    '/classes', '/classes/abc/attendance/edit', '/classes/abc/grade-answer',
    '/classes/abc/lifecycle', '/classes/abc/completion',
    '/classes/abc/fire-question', '/classes/bank/abc',
  ];
  for (const p of blocked) assert.equal(allows('POST', p), false, `POST ${p} must be blocked`);
  assert.equal(allows('PUT', '/classes/abc'), false, 'PUT /classes/:id must be blocked');
  // Syllabus and roster are the head trainer's, not branch scheduling.
  for (const p of ['/courses/p1/modules', '/courses/p1/trainers', '/courses/p1/create-trainer']) {
    assert.equal(allows('POST', p), false, `POST ${p} must be blocked`);
  }
});

test('user grant does not leak the rest of the users module', () => {
  // Only POST / and PUT /:id were granted. Anything else under /users that
  // happens to be a write stays blocked.
  for (const p of ['/users/abc/reset-password', '/users/abc/offboard', '/users/abc/restore']) {
    assert.equal(allows('POST', p), false, `POST ${p} must be blocked`);
  }
  // The PUT entry is anchored to a SINGLE path segment on purpose. A regex of
  // /^\/users\// would also sweep in every PUT sub-path under the module —
  // including /users/:id/role, the privilege-escalation route — so the depth
  // is asserted, not just the happy path.
  for (const p of ['/users/abc/role', '/users/abc/branch', '/users/abc/permissions']) {
    assert.equal(allows('PUT', p), false, `PUT ${p} must be blocked`);
  }
});

test('view-as start/stop allowed, its read-back is not a write', () => {
  assert.ok(allows('POST', '/view-as/start'));
  assert.ok(allows('POST', '/view-as/stop'));
  // /sessions is a GET in the router; a POST to it is not a route and must not
  // be swept in by a loose regex.
  assert.equal(allows('POST', '/view-as/sessions'), false);
});
