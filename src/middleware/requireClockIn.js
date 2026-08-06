import { isClockedInToday } from '../modules/work-sessions/repo.js';
import { clockInRequired } from '../lib/errors.js';

// Hard-blocks the substantive work routes (leads, follow-ups, calls,
// dashboard/analytics) for any tenant role that's supposed to track time
// (req.user.trackWork — set at login, false for super_admin/platform roles)
// unless they have an open work session today. Gated per-tenant on
// tenants.clock_in_enforced so the feature ships off and gets piloted branch
// by branch before it can lock out a whole tenant's staff.
export const requireClockIn = async (req, _res, next) => {
  try {
    if (!req.user?.trackWork) return next();
    if (!req.tenant?.clock_in_enforced) return next();
    if (await isClockedInToday(req.tenant, req.user.id)) return next();
    return next(clockInRequired());
  } catch (err) {
    next(err);
  }
};
