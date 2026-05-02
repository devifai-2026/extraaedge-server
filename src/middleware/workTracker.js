// Writes a UTC-minute bucket for the current user if trackWork=true.
// Skipped for platform roles (no tenant DB) and super_admin (trackWork=false in JWT).
// Idempotent insert — ON CONFLICT DO NOTHING.
export const workTracker = (req, _res, next) => {
  if (!req.user || !req.user.trackWork || !req.tenant || !req.db) return next();
  req.db
    .query(
      `INSERT INTO work_activity_minutes (user_id, minute_bucket)
       VALUES ($1, date_trunc('minute', now()))
       ON CONFLICT DO NOTHING`,
      [req.user.id],
    )
    .catch(() => {
      // bucket insert must never break a request
    });
  next();
};
