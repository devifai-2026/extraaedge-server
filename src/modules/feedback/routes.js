// In-app feedback popup (tenant-user facing).
//
//   GET  /feedback/status   → { show, submitted } — should the FE show the
//                             popup right now? show=false if already submitted
//                             OR dismissed less than RESHOW_MINUTES ago.
//   POST /feedback/submit   → { rating(1-5), comment } — records the response
//                             once (unique per user) and stops the popup forever.
//   POST /feedback/dismiss  → user closed the popup → stamp last_dismissed_at so
//                             it re-appears RESHOW_MINUTES later (persists across
//                             logins, since it's server-side).
import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { conflict } from '../../lib/errors.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// Re-show the popup this many minutes after a dismiss. Real-time (wall-clock),
// tracked via last_dismissed_at, so closing then logging out/in still re-shows.
const RESHOW_MINUTES = 5;

router.get('/status', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT submitted_at, last_dismissed_at FROM user_feedback_state WHERE user_id = $1`,
      [req.user.id],
    );
    const st = rows[0];
    // No state row yet → never seen it → show.
    // Submitted → never show again.
    // Dismissed → show only once RESHOW_MINUTES have passed since the dismiss.
    let show = true;
    const submitted = Boolean(st?.submitted_at);
    if (submitted) {
      show = false;
    } else if (st?.last_dismissed_at) {
      const elapsedMin = (Date.now() - new Date(st.last_dismissed_at).getTime()) / 60000;
      show = elapsedMin >= RESHOW_MINUTES;
    }
    res.json({ data: { show, submitted, reshow_minutes: RESHOW_MINUTES }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post(
  '/submit',
  validate({ body: z.object({ rating: z.coerce.number().int().min(1).max(5), comment: z.string().trim().min(1) }) }),
  async (req, res, next) => {
    try {
      const { rating, comment } = req.body;
      // One submission per user, ever. The UNIQUE(user_id) index enforces it;
      // surface a clean 409 if they somehow submit twice.
      try {
        await tenantQuery(
          req.tenant,
          `INSERT INTO user_feedback (user_id, rating, comment) VALUES ($1, $2, $3)`,
          [req.user.id, rating, comment],
        );
      } catch (err) {
        if (err?.code === '23505') throw conflict('Feedback already submitted');
        throw err;
      }
      // Mark submitted so the popup never returns.
      await tenantQuery(
        req.tenant,
        `INSERT INTO user_feedback_state (user_id, submitted_at, updated_at)
         VALUES ($1, now(), now())
         ON CONFLICT (user_id) DO UPDATE SET submitted_at = now(), updated_at = now()`,
        [req.user.id],
      );
      res.status(201).json({ data: { submitted: true }, meta: { requestId: req.id } });
    } catch (err) { next(err); }
  },
);

router.post('/dismiss', async (req, res, next) => {
  try {
    // Don't overwrite a submitted state (defensive — FE won't call this after
    // submit, but a stale tab might). Only bump last_dismissed_at.
    await tenantQuery(
      req.tenant,
      `INSERT INTO user_feedback_state (user_id, last_dismissed_at, updated_at)
       VALUES ($1, now(), now())
       ON CONFLICT (user_id) DO UPDATE
         SET last_dismissed_at = now(), updated_at = now()
       WHERE user_feedback_state.submitted_at IS NULL`,
      [req.user.id],
    );
    res.json({ data: { dismissed: true }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
