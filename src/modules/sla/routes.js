import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { SYSTEM_TENANT_ROLES, LEAD_OWNER_ROLES, MANAGER_TIER_ROLES } from '../../config/constants.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const policySchema = z.object({
  name: z.string().min(1),
  condition_json: z.record(z.string(), z.any()).default({}),
  no_activity_hours: z.coerce.number().int().positive(),
  escalate_after_hours: z.coerce.number().int().positive().optional(),
  action_json: z.array(z.any()).default([]),
  is_active: z.boolean().default(true),
});
const idParam = z.object({ id: z.string().uuid() });
const alertsQuery = z.object({
  user_id: z.string().uuid().optional(),
  status: z.enum(['open', 'resolved']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

// ---------------------------------------------------------------------------
// Stale-lead handovers — admin visibility for the 6-day / 7-day rule.
//
// The rule: no activity on a lead for 6 days notifies the owner + their
// manager chain; on day 7 the lead is auto-reassigned to someone else in the
// SAME role class (counsellor -> counsellor, telecaller -> telecaller).
// The scanner does all of that silently, so before this endpoint the only way
// to answer "what moved, and to whom?" was to read sla_alerts by hand.
//
// One row = one stale-lead alert, with the handover attached when it happened:
//   pending  — flagged (day 6), not yet escalated. Nobody notified again yet.
//   moved    — escalated AND a reassignment landed. to_name is the new owner.
//   held     — escalated but NOBODY was available in the same role class, so
//              the lead deliberately stayed put (pickSameRoleReplacement
//              returns null rather than crossing the class or unassigning).
//   resolved — the owner touched the lead in time; no handover.
//
// The handover is matched from lead_assignments by the reason string the
// scanner writes, bounded to a short window after escalation so an unrelated
// manual reassign on the same lead is never mistaken for the SLA's own move.
const handoverQuery = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  from_user_id: z.string().uuid().optional(),
  to_user_id: z.string().uuid().optional(),
  outcome: z.enum(['pending', 'moved', 'held', 'resolved', 'saved']).optional(),
  // Find one lead in a list thousands of rows long: matches lead name or
  // phone. Trimmed so a stray space from the search box doesn't kill every
  // match, and capped to keep the ILIKE bounded.
  search: z.string().trim().max(100).optional(),
  // 'history' (default) = what already happened. 'upcoming' = the pipeline:
  // open leads still inside the window, ordered by how soon they go stale.
  view: z.enum(['history', 'upcoming', 'criteria']).optional().default('history'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// Front-line roles are admitted too, but FORCED to their own rows below — the
// 6/7-day rule takes leads away from them, so the owner needs to see the
// warning inside the window. Managers keep the full scoped view.
router.get('/handovers', requireRole(...MANAGER_TIER_ROLES, ...LEAD_OWNER_ROLES), validate({ query: handoverQuery }), async (req, res, next) => {
  try {
    const q = req.query;
    // A lead owner sees only their OWN rows, and cannot widen that by sending
    // a from_user_id — the client is never trusted here.
    //
    // "Their own" deliberately means BOTH directions: a lead taken away from
    // them (they were the owner when it was flagged) AND a lead handed to them
    // (they are the current owner, or received it in the handover). A
    // counsellor who only saw what they lost would have no way to see the
    // leads that landed on their desk from someone else's inactivity.
    const selfOnly = LEAD_OWNER_ROLES.includes(req.user.role)
      && !MANAGER_TIER_ROLES.includes(req.user.role);
    if (selfOnly) delete q.from_user_id;

    // ---- Criteria: the rule itself, with live counts -------------------
    // Every gate below is copied from the scanner's own stale-lead SELECT
    // (workers/sla-scanner.js) and the seeded policy's condition_json, and each
    // one is COUNTED against live data rather than described in prose. Prose
    // drifts from behaviour; a count cannot. This is the tab that answers
    // "which leads will move, and why is this one not in the list?".
    if (q.view === 'criteria') {
      const { rows: [policy] } = await tenantQuery(
        req.tenant,
        `SELECT id, name, no_activity_hours, escalate_after_hours, created_at, condition_json
           FROM sla_policies
          WHERE is_active AND deleted_at IS NULL
          ORDER BY created_at
          LIMIT 1`,
      );
      if (!policy) {
        return res.json({
          data: [],
          meta: { requestId: req.id, view: 'criteria', policy: null, active: false },
        });
      }

      // One pass over leads, counting how many are EXCLUDED by each gate.
      // Deliberately independent of each other (not cumulative) so a row reads
      // as "N leads are out because of this rule".
      const { rows: [c] } = await tenantQuery(
        req.tenant,
        `SELECT
           count(*)::int AS total,
           count(*) FILTER (WHERE assigned_to IS NULL)::int AS unassigned,
           count(*) FILTER (WHERE converted_at IS NOT NULL)::int AS converted,
           count(*) FILTER (WHERE is_cold)::int AS cold,
           count(*) FILTER (WHERE last_activity_at < $2)::int AS before_policy,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM lead_followups f WHERE f.lead_id = leads.id AND f.deleted_at IS NULL))::int AS has_followup,
           count(*) FILTER (
             WHERE assigned_to IS NOT NULL AND converted_at IS NULL AND NOT is_cold
               AND last_activity_at >= $2
               AND last_activity_at < now() - ($1 * interval '1 hour')
               AND NOT EXISTS (SELECT 1 FROM lead_followups f WHERE f.lead_id = leads.id AND f.deleted_at IS NULL)
           )::int AS due_now,
           count(*) FILTER (
             WHERE assigned_to IS NOT NULL AND converted_at IS NULL AND NOT is_cold
               AND last_activity_at >= $2
               AND last_activity_at >= now() - ($1 * interval '1 hour')
               AND NOT EXISTS (SELECT 1 FROM lead_followups f WHERE f.lead_id = leads.id AND f.deleted_at IS NULL)
           )::int AS in_window
          FROM leads
         WHERE deleted_at IS NULL${selfOnly ? ' AND assigned_to = $3::uuid' : ''}`,
        selfOnly
          ? [policy.no_activity_hours, policy.created_at, req.user.id]
          : [policy.no_activity_hours, policy.created_at],
      );

      const days = Math.round(policy.no_activity_hours / 24);
      const moveDays = Math.round((policy.no_activity_hours + (policy.escalate_after_hours ?? 0)) / 24);

      // include=true  -> this is a condition a lead must MEET to be eligible.
      // include=false -> this is an exemption that keeps a lead OUT.
      const data = [
        {
          key: 'no_activity',
          include: true,
          rule: `No activity for ${days} days`,
          detail: `Counted from the lead's last human touch. Completing or rescheduling a follow-up, adding a comment, logging a call or changing the stage all reset this clock. Automatic events (missed follow-up, overdue reminder, the handover itself) do NOT — they are the system noticing, not a person working the lead.`,
          count: c.due_now,
          count_label: 'past the window right now',
        },
        {
          key: 'assigned',
          include: true,
          rule: 'Has an owner',
          detail: 'An unassigned lead has nobody to take it from, so it is never in the rotation.',
          count: c.unassigned,
          count_label: 'excluded — unassigned',
        },
        {
          key: 'open',
          include: false,
          rule: 'Not already converted',
          detail: 'A converted lead is finished and is left alone.',
          count: c.converted,
          count_label: 'excluded — converted',
        },
        {
          key: 'not_cold',
          include: false,
          rule: 'Not parked as cold',
          detail: 'Leads explicitly marked cold are deliberately out of the rotation.',
          count: c.cold,
          count_label: 'excluded — cold',
        },
        {
          key: 'has_followup',
          include: false,
          rule: 'No follow-up on the lead',
          detail: 'A lead with a follow-up of any kind — booked, missed, completed or cancelled — is never auto-reassigned. Someone has engaged with it and owns the next step. A MISSED follow-up means the owner needs chasing, not that the lead should be taken away: those appear under Sales → Missed Leads.',
          count: c.has_followup,
          count_label: 'excluded — have a follow-up',
        },
        {
          key: 'backlog_guard',
          include: false,
          rule: 'Last touched after the rule was switched on',
          detail: `A lead whose last activity predates the policy (${new Date(policy.created_at).toLocaleDateString()}) is never swept up by it, so turning the rule on cannot redistribute the whole historical database at once. Touch such a lead once and it joins the rotation normally.`,
          count: c.before_policy,
          count_label: 'excluded — pre-date the rule',
        },
        {
          key: 'one_alert',
          include: false,
          rule: 'Not already flagged',
          detail: 'A lead with an open alert is not flagged again; it is waiting on day 7 or on its owner.',
          count: null,
          count_label: null,
        },
      ];

      return res.json({
        data,
        meta: {
          requestId: req.id,
          view: 'criteria',
          active: true,
          policy: {
            name: policy.name,
            no_activity_hours: policy.no_activity_hours,
            escalate_after_hours: policy.escalate_after_hours,
            created_at: policy.created_at,
            flag_days: days,
            move_days: moveDays,
          },
          totals: {
            total: c.total,
            due_now: c.due_now,
            in_window: c.in_window,
          },
        },
      });
    }

    // ---- Upcoming: leads heading TOWARD a move -------------------------
    // Same predicate the scanner flags on (workers/sla-scanner.js), just
    // before the threshold instead of after: owned, open, not already
    // flagged, and past the policy's backlog guard (a lead last touched
    // before the policy existed never enters the rotation — see the
    // BACKLOG GUARD comment in the scanner).
    //
    // due_at is when it goes stale (day 6) and move_at when it would be
    // reassigned (day 7). The new owner is deliberately NOT predicted: the
    // pick is made at escalation time from whoever is least loaded THEN, so
    // naming someone now would be a guess that goes stale the moment anyone
    // is assigned a lead. The UI shows "TBD" and the role class the lead
    // will stay inside, which is the part that is actually knowable.
    if (q.view === 'upcoming') {
      const { rows: [policy] } = await tenantQuery(
        req.tenant,
        `SELECT id, no_activity_hours, escalate_after_hours, created_at
           FROM sla_policies
          WHERE is_active AND deleted_at IS NULL
          ORDER BY created_at
          LIMIT 1`,
      );
      if (!policy) {
        return res.json({ data: [], meta: { requestId: req.id, count: 0, view: 'upcoming', totals: null } });
      }

      // $1 window hours, $2 backlog guard, $3 policy id, $4 escalate hours.
      // Optional owner filter appends as $5.
      const uParams = [
        policy.no_activity_hours,
        policy.created_at,
        policy.id,
        policy.escalate_after_hours ?? 0,
      ];
      const uConds = [
        'l.deleted_at IS NULL',
        'l.assigned_to IS NOT NULL',
        'l.converted_at IS NULL',
        'l.last_activity_at >= $2',                                 // backlog guard
        "l.last_activity_at >= now() - ($1 * interval '1 hour')",   // not yet due
        'NOT EXISTS (SELECT 1 FROM sla_alerts a WHERE a.lead_id = l.id AND a.policy_id = $3 AND a.resolved_at IS NULL)',
        // Mirrors the scanner: any follow-up at all (planned, missed, done,
        // cancelled) takes the lead out of the rotation.
        'NOT EXISTS (SELECT 1 FROM lead_followups f WHERE f.lead_id = l.id AND f.deleted_at IS NULL)',
      ];
      if (selfOnly) {
        // "Coming up" is about leads that could move AWAY from you, so it is
        // by definition the ones you currently hold.
        uParams.push(req.user.id);
        uConds.push(`l.assigned_to = $${uParams.length}::uuid`);
      } else if (q.from_user_id) {
        uParams.push(q.from_user_id);
        uConds.push(`l.assigned_to = $${uParams.length}::uuid`);
      }
      // Same name-or-phone search as the history view, so the box behaves
      // identically on both tabs.
      if (q.search) {
        const digits = q.search.replace(/\D/g, '');
        uParams.push(`%${q.search.replace(/([%_\\])/g, '\\$1')}%`);
        const nameP = `$${uParams.length}`;
        if (digits.length >= 3) {
          uParams.push(`%${digits}%`);
          uConds.push(`(l.name ILIKE ${nameP} ESCAPE '\\' OR regexp_replace(coalesce(l.phone,''), '\\D', '', 'g') LIKE $${uParams.length})`);
        } else {
          uConds.push(`(l.name ILIKE ${nameP} ESCAPE '\\')`);
        }
      }
      const uWhere = uConds.join(' AND ');

      const pageParams = [...uParams, q.limit, (q.page - 1) * q.limit];
      const { rows } = await tenantQuery(
        req.tenant,
        `SELECT l.id                AS lead_id,
                l.name              AS lead_name,
                l.phone             AS lead_phone,
                l.last_activity_at,
                l.assigned_to       AS from_user_id,
                f.name              AS from_name,
                f.role              AS from_role,
                (l.last_activity_at + ($1 * interval '1 hour'))              AS due_at,
                (l.last_activity_at + (($1 + $4) * interval '1 hour'))       AS move_at,
                GREATEST(0, round(extract(epoch from (
                  l.last_activity_at + ($1 * interval '1 hour') - now()
                )) / 3600))::int    AS hours_left
           FROM leads l
           JOIN users f ON f.id = l.assigned_to
          WHERE ${uWhere}
          ORDER BY l.last_activity_at ASC
          LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
        pageParams,
      );

      // uWhere references $1-$3 (+$5 when an owner filter is set) but never
      // $4 (escalate hours, used only in the SELECT above). Postgres rejects a
      // bind with more parameters than the statement references, so build the
      // totals query with $4 consumed harmlessly rather than trimming the
      // array — which would renumber the optional owner filter.
      const { rows: [utot] } = await tenantQuery(
        req.tenant,
        `SELECT count(*)::int AS in_rotation,
                count(*) FILTER (
                  WHERE l.last_activity_at < now() - (GREATEST($1 - 24, 0) * interval '1 hour')
                )::int AS due_within_24h,
                ($4 * 0)::int AS _unused
           FROM leads l
          WHERE ${uWhere}`,
        uParams,
      );

      return res.json({
        data: rows,
        meta: {
          requestId: req.id,
          count: rows.length,
          view: 'upcoming',
          page: q.page,
          limit: q.limit,
          policy: {
            no_activity_hours: policy.no_activity_hours,
            escalate_after_hours: policy.escalate_after_hours,
          },
          // Drop the $4-consuming placeholder column from the payload.
          totals: utot ? { in_rotation: utot.in_rotation, due_within_24h: utot.due_within_24h } : null,
        },
      });
    }

    const conds = ['l.deleted_at IS NULL'];
    const params = [];
    const add = (sql, val) => { params.push(val); conds.push(sql.replace('$$', `$${params.length}`)); };

    if (q.date_from) add('a.flagged_at >= $$::timestamptz', q.date_from);
    if (q.date_to) {
      add('a.flagged_at <= $$::timestamptz', /^\d{4}-\d{2}-\d{2}$/.test(q.date_to) ? `${q.date_to}T23:59:59.999` : q.date_to);
    }
    if (selfOnly) {
      // Flagged on them, currently theirs, or handed to them.
      params.push(req.user.id);
      conds.push(`(a.assigned_to = $${params.length}::uuid OR l.assigned_to = $${params.length}::uuid OR mv.assigned_to = $${params.length}::uuid)`);
    } else if (q.from_user_id) {
      add('a.assigned_to = $$::uuid', q.from_user_id);
    }
    // Name OR phone in one box. Phone is matched on digits only so a search
    // for "9545747384" still finds a lead stored as "+91 95457 47384", and
    // name uses a plain contains match. ESCAPE guards a literal % or _ typed
    // by the user from turning into a wildcard.
    if (q.search) {
      const digits = q.search.replace(/\D/g, '');
      const like = `%${q.search.replace(/([%_\\])/g, '\\$1')}%`;
      params.push(like);
      const nameP = `$${params.length}`;
      if (digits.length >= 3) {
        params.push(`%${digits}%`);
        conds.push(`(l.name ILIKE ${nameP} ESCAPE '\\' OR regexp_replace(coalesce(l.phone,''), '\\D', '', 'g') LIKE $${params.length})`);
      } else {
        conds.push(`(l.name ILIKE ${nameP} ESCAPE '\\')`);
      }
    }

    // Outcome maps onto the alert's own lifecycle columns.
    if (q.outcome === 'pending') conds.push('a.escalated_at IS NULL AND a.resolved_at IS NULL');
    // 'saved' = flagged on day 6, then the owner touched the lead (completed or
    // rescheduled a follow-up, added a comment, logged a call) before day 7, so
    // the handover never happened. The scanner stamps exactly this case as
    // resolution_reason='activity_logged'. Split out from 'resolved' because
    // "the owner rescued it" and "a manager closed the alert by hand" are
    // different stories, and this is the one that answers "which leads were
    // ABOUT to move but didn't?".
    else if (q.outcome === 'saved') conds.push("a.resolved_at IS NOT NULL AND a.escalated_at IS NULL AND a.resolution_reason = 'activity_logged'");
    else if (q.outcome === 'resolved') conds.push("a.resolved_at IS NOT NULL AND a.escalated_at IS NULL AND a.resolution_reason IS DISTINCT FROM 'activity_logged'");
    else if (q.outcome === 'moved') conds.push('a.escalated_at IS NOT NULL AND mv.id IS NOT NULL');
    else if (q.outcome === 'held') conds.push('a.escalated_at IS NOT NULL AND mv.id IS NULL');

    if (q.to_user_id) add('mv.assigned_to = $$::uuid', q.to_user_id);

    params.push(q.limit, (q.page - 1) * q.limit);

    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT a.id,
              a.lead_id,
              l.name                AS lead_name,
              l.phone               AS lead_phone,
              a.flagged_at,
              a.escalated_at,
              a.resolved_at,
              a.hold_reason,
              a.handover_attempts,
              a.resolution_reason,
              a.assigned_to         AS from_user_id,
              f.name                AS from_name,
              f.role                AS from_role,
              -- Who holds the lead RIGHT NOW. For a 'moved' row this equals
              -- the recipient; for 'resolved'/'held'/'pending' it is still the
              -- original owner, which is the question the table has to answer
              -- ("so who has it?") and could not before.
              l.assigned_to         AS current_user_id,
              cur.name              AS current_name,
              cur.role              AS current_role,
              mv.assigned_to        AS to_user_id,
              t.name                AS to_name,
              t.role                AS to_role,
              mv.created_at         AS moved_at,
              CASE
                WHEN a.escalated_at IS NOT NULL AND mv.id IS NOT NULL THEN 'moved'
                WHEN a.escalated_at IS NOT NULL                        THEN 'held'
                WHEN a.resolved_at IS NOT NULL
                 AND a.resolution_reason = 'activity_logged'           THEN 'saved'
                WHEN a.resolved_at  IS NOT NULL                        THEN 'resolved'
                ELSE 'pending'
              END                   AS outcome,
              -- For a 'saved' row: WHICH human action rescued it. The first
              -- activity by a real person between the flag and the resolve is
              -- the one that moved last_activity_at past flagged_at and so
              -- stopped the handover. user_id IS NOT NULL keeps out the
              -- system's own rows ('follow_up_missed', 'followup_overdue'),
              -- which are never a rescue.
              sv.type               AS saved_by_type,
              sv.summary            AS saved_by_summary,
              sv.created_at         AS saved_at,
              sv.actor_name         AS saved_by_name
         FROM sla_alerts a
         JOIN leads l  ON l.id = a.lead_id
         LEFT JOIN users f ON f.id = a.assigned_to
         LEFT JOIN users cur ON cur.id = l.assigned_to
         -- The scanner's own handover for this alert: same lead, same outgoing
         -- owner, its SLA reason, at/after the escalation. LATERAL keeps it to
         -- the single nearest row so a later manual move can't be picked up.
         LEFT JOIN LATERAL (
           SELECT la.id, la.assigned_to, la.created_at
             FROM lead_assignments la
            WHERE la.lead_id = a.lead_id
              AND la.from_user_id = a.assigned_to
              AND la.reason ILIKE 'SLA:%'
              AND a.escalated_at IS NOT NULL
              AND la.created_at >= a.escalated_at - interval '1 minute'
            ORDER BY la.created_at
            LIMIT 1
         ) mv ON true
         LEFT JOIN users t ON t.id = mv.assigned_to
         LEFT JOIN LATERAL (
           SELECT act.type, act.summary, act.created_at, au.name AS actor_name
             FROM lead_activities act
             LEFT JOIN users au ON au.id = act.user_id
            WHERE act.lead_id = a.lead_id
              AND act.user_id IS NOT NULL
              AND act.created_at >= a.flagged_at
              AND (a.resolved_at IS NULL OR act.created_at <= a.resolved_at)
            ORDER BY act.created_at
            LIMIT 1
         ) sv ON a.resolved_at IS NOT NULL AND a.resolution_reason = 'activity_logged'
        WHERE ${conds.join(' AND ')}
        ORDER BY COALESCE(mv.created_at, a.escalated_at, a.flagged_at) DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    // Headline counts so the tab can show "N moved / N held / N pending"
    // without a second round trip. Tenant-wide for managers, but a lead owner
    // must only ever be counted on their OWN rows — otherwise the tiles would
    // leak the tenant's totals to someone whose table shows six leads.
    const totWhere = selfOnly
      ? `WHERE l.deleted_at IS NULL AND (a.assigned_to = $1::uuid OR l.assigned_to = $1::uuid OR mv.assigned_to = $1::uuid)`
      : `WHERE l.deleted_at IS NULL`;
    const { rows: [tot] } = await tenantQuery(
      req.tenant,
      `SELECT count(*) FILTER (WHERE a.escalated_at IS NULL AND a.resolved_at IS NULL)::int AS pending,
              count(*) FILTER (WHERE a.escalated_at IS NOT NULL AND mv.id IS NOT NULL)::int AS moved,
              count(*) FILTER (WHERE a.escalated_at IS NOT NULL AND mv.id IS NULL)::int     AS held,
              -- Flagged, then rescued by a human touch before the handover.
              count(*) FILTER (WHERE a.escalated_at IS NULL AND a.resolved_at IS NOT NULL
                                 AND a.resolution_reason = 'activity_logged')::int          AS saved
         FROM sla_alerts a
         JOIN leads l ON l.id = a.lead_id
         LEFT JOIN LATERAL (
           SELECT la.id, la.assigned_to FROM lead_assignments la
            WHERE la.lead_id = a.lead_id AND la.from_user_id = a.assigned_to
              AND la.reason ILIKE 'SLA:%' AND a.escalated_at IS NOT NULL
              AND la.created_at >= a.escalated_at - interval '1 minute'
            LIMIT 1
         ) mv ON true
        ${totWhere}`,
      selfOnly ? [req.user.id] : [],
    );

    return res.json({
      data: rows,
      meta: { requestId: req.id, count: rows.length, page: q.page, limit: q.limit, totals: tot },
    });
  } catch (err) { next(err); }
});

// Policies
router.get('/', requireRole(...MANAGER_TIER_ROLES), async (req, res, next) => {
  try { const { rows } = await tenantQuery(req.tenant, `SELECT * FROM sla_policies WHERE deleted_at IS NULL ORDER BY name`); res.json({ data: rows, meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});

router.post('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ body: policySchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO sla_policies (name, condition_json, no_activity_hours, escalate_after_hours, action_json, is_active)
       VALUES ($1,$2::jsonb,$3,$4,$5::jsonb,$6) RETURNING *`,
      [req.body.name, JSON.stringify(req.body.condition_json), req.body.no_activity_hours, req.body.escalate_after_hours ?? null, JSON.stringify(req.body.action_json), req.body.is_active],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam, body: policySchema.partial() }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined) continue;
      const val = ['condition_json', 'action_json'].includes(k) ? JSON.stringify(v) : v;
      fields.push(`${k} = $${i}`); params.push(val); i += 1;
    }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE sla_policies SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING *`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try { await tenantQuery(req.tenant, `UPDATE sla_policies SET deleted_at = now() WHERE id = $1`, [req.params.id]); res.status(204).end(); }
  catch (err) { next(err); }
});

router.post('/:id/toggle', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `UPDATE sla_policies SET is_active = NOT is_active WHERE id = $1 RETURNING *`, [req.params.id]);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Alerts
router.get('/alerts', validate({ query: alertsQuery }), async (req, res, next) => {
  try {
    const conds = [];
    const params = [];
    if (req.query.user_id) { params.push(req.query.user_id); conds.push(`a.assigned_to = $${params.length}`); }
    if (req.query.status === 'open') conds.push('a.resolved_at IS NULL');
    if (req.query.status === 'resolved') conds.push('a.resolved_at IS NOT NULL');
    // Front-line users (counsellor / telecaller) only ever see their own
    // breaches; manager tiers see everyone's.
    if (LEAD_OWNER_ROLES.includes(req.user.role)) {
      params.push(req.user.id);
      conds.push(`a.assigned_to = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT a.*, l.name AS lead_name, p.name AS policy_name, u.name AS assigned_to_name
         FROM sla_alerts a
         LEFT JOIN leads l ON l.id = a.lead_id
         LEFT JOIN sla_policies p ON p.id = a.policy_id
         LEFT JOIN users u ON u.id = a.assigned_to
         ${where}
         ORDER BY a.flagged_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/alerts/:id/resolve', validate({ params: idParam, body: z.object({ reason: z.string().optional() }) }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `UPDATE sla_alerts SET resolved_at = now(), resolved_by = $2, resolution_reason = $3 WHERE id = $1 AND resolved_at IS NULL RETURNING *`,
      [req.params.id, req.user.id, req.body.reason ?? 'manual_resolve'],
    );
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/alerts/summary', requireRole(...MANAGER_TIER_ROLES), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT u.id, u.name, count(*)::int AS open_count
         FROM sla_alerts a LEFT JOIN users u ON u.id = a.assigned_to
        WHERE a.resolved_at IS NULL
        GROUP BY u.id, u.name ORDER BY open_count DESC`,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
