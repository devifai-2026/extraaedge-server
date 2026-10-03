import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import { startViewAsSchema, listQuery } from './schema.js';

const router = express.Router();

router.use(authRequired, tenantRequired);

// Start looking at a staff member's screens. branch_manager only — the
// service re-checks the role rather than trusting this gate alone, because
// the token it mints is the security boundary.
//
// This is a POST that must pass branchManagerReadOnly, so it is allowlisted
// there. It is safe to allowlist for the same reason reveal-phone is: it
// writes an AUDIT row and returns a token that is still read-only. Nothing in
// the CRM changes.
router.post(
  '/start',
  requireRole(SYSTEM_TENANT_ROLES.BRANCH_MANAGER),
  validate({ body: startViewAsSchema }),
  controller.start,
);

// End the session early. No role gate: the caller must already be holding a
// view-as token (service reads viewAsSessionId off it) and may only close
// their own row.
router.post('/stop', controller.stop);

// The audit read-back. A branch manager sees their own history; a super_admin
// sees the tenant's — someone must be able to answer "who has been looking at
// this counsellor's screens".
router.get(
  '/sessions',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER),
  validate({ query: listQuery }),
  controller.list,
);

export default router;
