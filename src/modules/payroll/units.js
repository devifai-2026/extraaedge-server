// What actually happened this month, per employee.
//
// The calc engine is pure; this is the half that touches reality. Every counter
// here answers one question: how many billable UNITS does this person have for
// this pay head, for this month?
//
// Two rules hold throughout:
//   1. Count only COMPLETED work. A class the trainer never marked complete
//      does not pay — that is the whole point of the completion flow.
//   2. Count in the tenant's timezone. The DB session TZ is pinned to the
//      tenant (see db/tenant.js), so date arithmetic below is already IST for
//      an Indian tenant and month boundaries do not drift.
import { tenantQuery } from '../../db/tenant.js';

// Billable classes a trainer COMPLETED, counted into the month the class was
// SCHEDULED for.
//
// The window keys off `ends_at`, not `ended_at`. `ended_at` records when the
// trainer pressed the button, which can be a day or two later — and for a class
// on the 31st, confirmed on the 1st, that would push the pay into the following
// month. The class belongs to the month it was taught in.
//
// `completion_status = 'completed'` is what makes it payable, so a class the
// trainer never confirmed (or that the 24-hour sweep closed as not conducted)
// pays nothing. `is_billable` is the manager's "this one is extra" flag — a
// regular timetable class is not an extra class.
export const completedClasses = async (tenant, { userIds, from, to }) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT trainer_id AS user_id, billing_kind AS code, count(*)::int AS units
       FROM (
         SELECT c.trainer_id,
                CASE WHEN c.kind = 'demo' THEN 'DEMO_CLASS' ELSE 'EXTRA_CLASS' END AS billing_kind
           FROM classes c
          WHERE c.deleted_at IS NULL
            AND c.is_billable IS TRUE
            AND c.completion_status = 'completed'
            AND c.trainer_id = ANY($1::uuid[])
            AND c.ends_at >= $2::date
            AND c.ends_at < ($3::date + 1)
       ) x
      GROUP BY trainer_id, billing_kind`,
    [userIds, from, to],
  );
  return rows;
};

// Admissions credited to a counsellor in the window.
//
// Dropped admissions are excluded: paying incentive on a student who left
// within the month is the classic way a sales incentive scheme leaks money.
export const admissionsClosed = async (tenant, { userIds, from, to }) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT guided_by_counsellor_id AS user_id, count(*)::int AS units
       FROM admissions
      WHERE deleted_at IS NULL
        AND dropped_at IS NULL
        AND guided_by_counsellor_id = ANY($1::uuid[])
        AND admission_date >= $2::date
        AND admission_date <= $3::date
      GROUP BY guided_by_counsellor_id`,
    [userIds, from, to],
  );
  return rows;
};

// Unpaid days, from leave the APPROVER marked as loss of pay.
//
// Clipped to the window: a leave spanning a month boundary must only cost the
// days that fall inside this payroll month, or the employee is docked twice.
export const lopDays = async (tenant, { userIds, from, to }) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT l.user_id,
            SUM(
              CASE
                -- A half day is a single date by construction, so it either
                -- falls in the window whole or not at all.
                WHEN l.day_count = 0.5 THEN 0.5
                ELSE LEAST(l.lop_days,
                           (LEAST(l.to_date, $3::date) - GREATEST(l.from_date, $2::date) + 1)::numeric)
              END
            )::numeric AS units
       FROM staff_leave l
      WHERE l.deleted_at IS NULL
        AND l.status = 'approved'
        AND l.lop_days > 0
        AND l.user_id = ANY($1::uuid[])
        AND l.to_date >= $2::date AND l.from_date <= $3::date
      GROUP BY l.user_id`,
    [userIds, from, to],
  );
  return rows;
};

// Working days in the month, minus org holidays. Weekends are NOT subtracted:
// the tenant runs a six-day week and the attendance register (B2) is the right
// place for a per-branch week-off pattern. Holidays are, because declaring one
// must never cost anybody pay.
export const workingDays = async (tenant, { from, to }) => {
  const { rows: [r] } = await tenantQuery(
    tenant,
    `SELECT ($2::date - $1::date + 1)
            - (SELECT count(DISTINCT date)::int FROM holidays
                WHERE date BETWEEN $1::date AND $2::date
                  AND deleted_at IS NULL
                  AND COALESCE(is_optional, false) = false) AS days`,
    [from, to],
  );
  return Number(r?.days ?? 30);
};

// One call, everything the calc engine needs: { [userId]: { [code]: units } }.
export const unitsFor = async (tenant, { userIds, from, to }) => {
  if (!userIds?.length) return {};
  const [classes, admissions, lop] = await Promise.all([
    completedClasses(tenant, { userIds, from, to }),
    admissionsClosed(tenant, { userIds, from, to }),
    lopDays(tenant, { userIds, from, to }),
  ]);

  const out = {};
  const put = (userId, code, units) => {
    if (!userId) return;
    out[userId] = out[userId] || {};
    out[userId][code] = (out[userId][code] || 0) + Number(units || 0);
  };

  for (const r of classes) put(r.user_id, r.code, r.units);
  // The same head covers both sales roles; which one applies is decided by the
  // employee's STRUCTURE, not here — a telecaller simply won't have ADM_INCENTIVE
  // on their structure if the tenant doesn't pay them for it.
  for (const r of admissions) put(r.user_id, 'ADM_INCENTIVE', r.units);
  for (const r of lop) put(r.user_id, 'LOP', r.units);
  return out;
};

export default unitsFor;
