import { env } from '../config/env.js';
import { sessionIdle } from '../lib/errors.js';

// Enforces max idle interval server-side (defense in depth on top of FE timer).
// Requires a loader that fetches the session's last_activity_at and updates it.
// Implementation note: the loader is tenant-scoped because user_sessions lives in the tenant DB.
// For platform users, sessions live in system DB; the loader dispatches accordingly.
export const idleGuard = ({ loadLastActivity, touchActivity }) => async (req, _res, next) => {
  try {
    if (!req.user || !req.user.sessionId) return next();
    const last = await loadLastActivity(req);
    if (last) {
      const idleMs = Date.now() - new Date(last).getTime();
      if (idleMs > env.IDLE_TIMEOUT_MINUTES * 60_000) {
        return next(sessionIdle());
      }
    }
    await touchActivity(req).catch(() => {});
    next();
  } catch (err) {
    next(err);
  }
};
