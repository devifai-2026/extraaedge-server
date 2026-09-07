// QA call-quality reviews.
//
// A QA reviewer works a queue of MATCHED device recordings — calls already
// bound to a lead, and through uploaded_by to the counsellor who made them —
// listens, and scores each against the tenant's rubric (Communication,
// Fluency, …) with a free-text comment. Managers read those reviews back
// branch-wise.
//
// Surfaces:
//   GET  /qa-reviews/parameters        the active rubric (QA + managers)
//   GET  /qa-reviews/queue             matched recordings + review state (QA)
//   POST /qa-reviews/:recordingId      submit / re-submit a review (QA)
//   GET  /qa-reviews                   submitted reviews (QA + managers)
//   GET  /qa-reviews/summary           per-counsellor averages (QA + managers)
//
// Branch scoping: every recording carries a branch_id snapshot taken from the
// uploading counsellor. A branch_manager is pinned to their own branch;
// everyone else may filter by one.
import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { teamHierarchy } from '../users/repo.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery, tenantTx } from '../../db/tenant.js';
import { notFound, validationError } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

const router = express.Router();

router.use(authRequired, tenantRequired);

// Who may score a call. The QA role and super_admin review across the tenant;
// a branch_manager reviews their branch, and a telecaller_lead reviews their
// own telecallers — both narrowed by applyReviewScope below, so widening this
// list does NOT widen what anyone can see.
const REVIEWER_ROLES = [
  SYSTEM_TENANT_ROLES.QA,
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
  SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  SYSTEM_TENANT_ROLES.TELECALLER_LEAD,
];
// Who may read the aggregate scorecards back (the QA Feedback report).
// telecaller_lead is deliberately NOT here: it scores its own team's calls via
// the queue above, but the cross-team feedback report belongs to the tiers
// above it. Its 'qa.feedback' tab is withheld to match, so no page appears in
// its sidebar that would 403.
const READER_ROLES = [
  SYSTEM_TENANT_ROLES.QA,
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
  SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  SYSTEM_TENANT_ROLES.SALES_MANAGER,
];

// A branch_manager only ever sees their own branch; anyone else may pass
// ?branch_id= to narrow. The access token carries no branch claim, so the
// pin is read from the users row.
const pinnedBranch = async (tenant, user) => {
  if (user.role !== SYSTEM_TENANT_ROLES.BRANCH_MANAGER) return null;
  const { rows } = await tenantQuery(tenant, `SELECT branch_id FROM users WHERE id = $1`, [user.id]);
  return rows[0]?.branch_id ?? null;
};

// Build the branch predicate for a query, honouring the pin. `col` is the
// qualified branch column on whichever table is being filtered.
//
// A branch manager with no branch on their row is pinned to NOTHING rather
// than to everything — falling through to an unfiltered read would quietly
// widen their scope to the whole tenant.
const applyBranch = async (req, requested, col, conds, params) => {
  const pin = await pinnedBranch(req.tenant, req.user);
  if (req.user.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER && !pin) {
    conds.push('false');
    return;
  }
  const branch = pin ?? requested ?? null;
  if (!branch) return;
  params.push(branch);
  conds.push(`${col} = $${params.length}`);
};

// Constrain a query to the reviewers/scorecards this actor may see.
//
// branch_manager is handled by applyBranch (branch-wide, by design).
// sales_manager is narrowed to the people who actually report to it — before
// this existed there was NO team filter here at all, so a sales_manager could
// read every counsellor's scorecards tenant-wide.
//
// telecaller_lead is deliberately NOT narrowed here. It acts as a REVIEWER:
// per the product decision it may review any recording in the tenant, not
// only its own telecallers'. Its team restriction still applies to the
// separate Call Recordings log (device-recordings visibleUploaderIds) — that
// is its team's upload history — but reviewing is a tenant-wide duty.
//
// `col` is the qualified column holding the reviewed user (dr.uploaded_by on
// the queue, qr.counsellor_id on the scorecards).
const applyReviewScope = async (req, col, conds, params) => {
  const role = req.user.role;
  if (role !== SYSTEM_TENANT_ROLES.SALES_MANAGER) return;
  const team = await teamHierarchy(req.tenant, req.user.id);
  // teamHierarchy includes the actor; a lead with no reports still sees only
  // themselves rather than falling through to an unfiltered read.
  params.push(team.length ? team : [req.user.id]);
  conds.push(`${col} = ANY($${params.length}::uuid[])`);
};

// Anyone who scores OR reads needs the rubric — a scorer can't render the
// score dialog without it. It's tenant-wide config (parameter names + max
// scores), not per-counsellor data, so there is nothing to scope here.
// De-duplicated because the two lists overlap and requireRole does a flat
// includes().
const RUBRIC_ROLES = [...new Set([...REVIEWER_ROLES, ...READER_ROLES])];

// ------------------------------- RUBRIC -------------------------------------
router.get('/parameters', requireRole(...RUBRIC_ROLES), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT id, code, name, max_score, order_index
         FROM qa_review_parameters
        WHERE is_active = true
        ORDER BY order_index ASC, name ASC`,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// -------------------------------- QUEUE -------------------------------------
// Matched recordings the QA team works through. `status=pending` hides the
// ones already scored — the default working view.
const queueQuery = z.object({
  status: z.enum(['pending', 'reviewed', 'all']).default('pending'),
  branch_id: z.string().uuid().optional(),
  counsellor_id: z.string().uuid().optional(),
  // Filters on the call's own uploaded_at (when it was recorded/uploaded),
  // not on when it was reviewed — that's what a QA manager means by "calls
  // from last week", regardless of review status.
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

router.get('/queue', requireRole(...REVIEWER_ROLES), validate({ query: queueQuery }), async (req, res, next) => {
  try {
    // Only matched calls are reviewable: an unmatched recording has no lead
    // and often no identified counsellor, so there's nobody to score.
    const conds = [`dr.deleted_at IS NULL`, `dr.match_status IN ('matched','multi')`];
    const params = [];
    await applyBranch(req, req.query.branch_id, 'dr.branch_id', conds, params);
    await applyReviewScope(req, 'dr.uploaded_by', conds, params);
    if (req.query.counsellor_id) { params.push(req.query.counsellor_id); conds.push(`dr.uploaded_by = $${params.length}`); }
    if (req.query.status === 'pending') conds.push(`qr.id IS NULL`);
    if (req.query.status === 'reviewed') conds.push(`qr.id IS NOT NULL`);
    if (req.query.date_from) { params.push(req.query.date_from); conds.push(`dr.uploaded_at >= $${params.length}::timestamptz`); }
    if (req.query.date_to) { params.push(req.query.date_to); conds.push(`dr.uploaded_at <= $${params.length}::timestamptz`); }

    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT dr.id, dr.phone_raw, dr.file_name, dr.duration_seconds, dr.uploaded_at,
              dr.lead_id, l.name AS lead_name,
              dr.uploaded_by AS counsellor_id, u.name AS counsellor_name,
              dr.branch_id, b.name AS branch_name,
              qr.id AS review_id, qr.overall_percent, qr.reviewed_at,
              count(*) OVER() AS total_count
         FROM device_recordings dr
         LEFT JOIN qa_reviews qr ON qr.recording_id = dr.id AND qr.deleted_at IS NULL
         LEFT JOIN leads    l ON l.id = dr.lead_id
         LEFT JOIN users    u ON u.id = dr.uploaded_by
         LEFT JOIN branches b ON b.id = dr.branch_id
        WHERE ${conds.join(' AND ')}
        ORDER BY dr.uploaded_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const total = rows[0] ? Number(rows[0].total_count) : 0;
    res.json({
      data: rows.map(({ total_count, ...r }) => r),
      meta: { requestId: req.id, total, page: req.query.page, limit: req.query.limit },
    });
  } catch (err) { next(err); }
});

// Write-side mirror of applyReviewScope + applyBranch, for the single-call
// scoring route where there is no query to attach predicates to.
const assertReviewableByActor = async (req, rec) => {
  const role = req.user.role;
  if (role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER) {
    const pin = await pinnedBranch(req.tenant, req.user);
    if (!pin || rec.branch_id !== pin) throw notFound('Recording not found');
    return;
  }
  // telecaller_lead is intentionally absent: it reviews any recording (see
  // applyReviewScope). sales_manager is not in REVIEWER_ROLES and so never
  // reaches this, but the check is kept so adding it later can't silently
  // grant tenant-wide scoring.
  if (role === SYSTEM_TENANT_ROLES.SALES_MANAGER) {
    const team = await teamHierarchy(req.tenant, req.user.id);
    const allowed = team.length ? team : [req.user.id];
    if (!allowed.includes(rec.uploaded_by)) throw notFound('Recording not found');
  }
};

// ------------------------------- SUBMIT -------------------------------------
// Upsert: re-submitting replaces the scores and comment in place, so a review
// can be corrected without accumulating duplicates.
const submitBody = z.object({
  scores: z.array(z.object({
    parameter_id: z.string().uuid(),
    score: z.coerce.number().min(0),
  })).min(1),
  comment: z.string().max(5000).optional(),
});
const recordingParam = z.object({ recordingId: z.string().uuid() });

router.post(
  '/:recordingId',
  requireRole(...REVIEWER_ROLES),
  validate({ params: recordingParam, body: submitBody }),
  async (req, res, next) => {
    try {
      const { recordingId } = req.params;
      const { rows: recRows } = await tenantQuery(
        req.tenant,
        `SELECT id, lead_id, uploaded_by, branch_id, match_status
           FROM device_recordings WHERE id = $1 AND deleted_at IS NULL`,
        [recordingId],
      );
      const rec = recRows[0];
      if (!rec) throw notFound('Recording not found');
      // A branch_manager may only score their own branch, a telecaller_lead
      // only their own telecallers. notFound (not forbidden) so we don't
      // confirm the existence of a call outside their scope.
      await assertReviewableByActor(req, rec);
      if (!['matched', 'multi'].includes(rec.match_status)) {
        throw validationError([{ path: 'recordingId', message: 'Only recordings attached to a lead can be reviewed' }]);
      }

      // Score every parameter against the CURRENT rubric: unknown ids are
      // rejected and an out-of-range score is a client bug, not something to
      // silently clamp.
      const { rows: params } = await tenantQuery(
        req.tenant,
        `SELECT id, max_score FROM qa_review_parameters WHERE is_active = true`,
      );
      const byId = new Map(params.map((p) => [p.id, Number(p.max_score)]));
      for (const s of req.body.scores) {
        const max = byId.get(s.parameter_id);
        if (max === undefined) {
          throw validationError([{ path: 'scores', message: `Unknown or inactive rubric parameter ${s.parameter_id}` }]);
        }
        if (s.score > max) {
          throw validationError([{ path: 'scores', message: `Score ${s.score} exceeds the maximum of ${max}` }]);
        }
      }

      const total = req.body.scores.reduce((sum, s) => sum + Number(s.score), 0);
      const maxTotal = req.body.scores.reduce((sum, s) => sum + byId.get(s.parameter_id), 0);
      const percent = maxTotal > 0 ? Math.round((total / maxTotal) * 10000) / 100 : null;

      const review = await tenantTx(req.tenant, async (client) => {
        const { rows: upserted } = await client.query(
          `INSERT INTO qa_reviews
             (recording_id, lead_id, counsellor_id, branch_id, total_score, max_total,
              overall_percent, comment, reviewed_by, reviewed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
           ON CONFLICT (recording_id) WHERE deleted_at IS NULL
           DO UPDATE SET total_score = EXCLUDED.total_score,
                         max_total = EXCLUDED.max_total,
                         overall_percent = EXCLUDED.overall_percent,
                         comment = EXCLUDED.comment,
                         reviewed_by = EXCLUDED.reviewed_by,
                         reviewed_at = now(),
                         updated_at = now()
           RETURNING id, overall_percent, reviewed_at`,
          [
            recordingId, rec.lead_id, rec.uploaded_by, rec.branch_id,
            total, maxTotal, percent, req.body.comment ?? null, req.user.id,
          ],
        );
        const reviewId = upserted[0].id;
        // Replace the score set wholesale — a rubric parameter removed since
        // the last submission shouldn't linger on the review.
        await client.query(`DELETE FROM qa_review_scores WHERE review_id = $1`, [reviewId]);
        for (const s of req.body.scores) {
          // eslint-disable-next-line no-await-in-loop
          await client.query(
            `INSERT INTO qa_review_scores (review_id, parameter_id, score, max_score)
             VALUES ($1,$2,$3,$4)`,
            [reviewId, s.parameter_id, s.score, byId.get(s.parameter_id)],
          );
        }
        return upserted[0];
      });

      res.status(201).json({ data: review, meta: { requestId: req.id } });
    } catch (err) { next(err); }
  },
);

// ------------------------------- READ BACK ----------------------------------
const listQuery = z.object({
  branch_id: z.string().uuid().optional(),
  counsellor_id: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

router.get('/', requireRole(...READER_ROLES), validate({ query: listQuery }), async (req, res, next) => {
  try {
    const conds = ['qr.deleted_at IS NULL'];
    const params = [];
    await applyBranch(req, req.query.branch_id, 'qr.branch_id', conds, params);
    await applyReviewScope(req, 'qr.counsellor_id', conds, params);
    if (req.query.counsellor_id) { params.push(req.query.counsellor_id); conds.push(`qr.counsellor_id = $${params.length}`); }
    if (req.query.from) { params.push(req.query.from); conds.push(`qr.reviewed_at >= $${params.length}::date`); }
    if (req.query.to) { params.push(req.query.to); conds.push(`qr.reviewed_at < ($${params.length}::date + interval '1 day')`); }

    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT qr.id, qr.recording_id, qr.lead_id, qr.overall_percent, qr.total_score,
              qr.max_total, qr.comment, qr.reviewed_at,
              l.name AS lead_name,
              c.name AS counsellor_name, qr.counsellor_id,
              rb.name AS reviewer_name,
              b.name AS branch_name, qr.branch_id,
              dr.phone_raw, dr.duration_seconds,
              COALESCE(
                (SELECT json_agg(json_build_object('name', p.name, 'code', p.code,
                                                   'score', s.score, 'max_score', s.max_score)
                                 ORDER BY p.order_index)
                   FROM qa_review_scores s
                   JOIN qa_review_parameters p ON p.id = s.parameter_id
                  WHERE s.review_id = qr.id),
                '[]'::json
              ) AS scores,
              count(*) OVER() AS total_count
         FROM qa_reviews qr
         LEFT JOIN leads l ON l.id = qr.lead_id
         LEFT JOIN users c ON c.id = qr.counsellor_id
         LEFT JOIN users rb ON rb.id = qr.reviewed_by
         LEFT JOIN branches b ON b.id = qr.branch_id
         LEFT JOIN device_recordings dr ON dr.id = qr.recording_id
        WHERE ${conds.join(' AND ')}
        ORDER BY qr.reviewed_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const total = rows[0] ? Number(rows[0].total_count) : 0;
    res.json({
      data: rows.map(({ total_count, ...r }) => r),
      meta: { requestId: req.id, total, page: req.query.page, limit: req.query.limit },
    });
  } catch (err) { next(err); }
});

// Per-counsellor roll-up for the manager view: how many calls were reviewed,
// the average overall score, and the average per rubric parameter.
const summaryQuery = z.object({
  branch_id: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

router.get('/summary', requireRole(...READER_ROLES), validate({ query: summaryQuery }), async (req, res, next) => {
  try {
    const conds = ['qr.deleted_at IS NULL'];
    const params = [];
    await applyBranch(req, req.query.branch_id, 'qr.branch_id', conds, params);
    await applyReviewScope(req, 'qr.counsellor_id', conds, params);
    if (req.query.from) { params.push(req.query.from); conds.push(`qr.reviewed_at >= $${params.length}::date`); }
    if (req.query.to) { params.push(req.query.to); conds.push(`qr.reviewed_at < ($${params.length}::date + interval '1 day')`); }

    const [{ rows: byCounsellor }, { rows: byParameter }] = await Promise.all([
      tenantQuery(
        req.tenant,
        `SELECT qr.counsellor_id, c.name AS counsellor_name,
                qr.branch_id, b.name AS branch_name,
                count(*)::int AS reviews,
                round(avg(qr.overall_percent), 2) AS avg_percent
           FROM qa_reviews qr
           LEFT JOIN users c ON c.id = qr.counsellor_id
           LEFT JOIN branches b ON b.id = qr.branch_id
          WHERE ${conds.join(' AND ')}
          GROUP BY qr.counsellor_id, c.name, qr.branch_id, b.name
          ORDER BY avg_percent DESC NULLS LAST`,
        params,
      ),
      tenantQuery(
        req.tenant,
        `SELECT p.code, p.name,
                round(avg(s.score), 2) AS avg_score,
                max(s.max_score) AS max_score
           FROM qa_review_scores s
           JOIN qa_reviews qr ON qr.id = s.review_id
           JOIN qa_review_parameters p ON p.id = s.parameter_id
          WHERE ${conds.join(' AND ')}
          GROUP BY p.code, p.name, p.order_index
          ORDER BY p.order_index`,
        params,
      ),
    ]);
    res.json({ data: { by_counsellor: byCounsellor, by_parameter: byParameter }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
