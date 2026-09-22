import { tenantQuery } from '../../db/tenant.js';

// Trainer performance, one row per (trainer × course × module).
//
// ON-TIME is judged against the module's end_date:
//   on_time   completed on or before end_date
//   late      completed after it
//   overdue   not completed and end_date has passed
//   running   not completed, end_date still ahead
//   unscheduled  no end_date — modules created before scheduling existed.
//              Deliberately NOT counted as a failure: the trainer never had a
//              deadline to miss, and grading them against one would make the
//              whole report untrustworthy on day one.
//
// A module auto-completes when every class under it is completed; the trainer
// can also mark it complete early. completed_at holds whichever happened, so
// this query does not care which route was taken.
const BASE = `
  WITH module_classes AS (
    SELECT c.module_id,
           count(*)::int AS classes_planned,
           count(*) FILTER (WHERE c.completion_status = 'completed')::int AS classes_completed,
           count(*) FILTER (WHERE c.ended_at IS NOT NULL)::int AS classes_ended
      FROM classes c
     WHERE c.deleted_at IS NULL AND c.module_id IS NOT NULL
     GROUP BY c.module_id
  ),
  module_attendance AS (
    SELECT c.module_id,
           count(*) FILTER (WHERE a.status = 'present')::int AS present_count,
           count(a.id)::int AS attendance_rows
      FROM classes c
      JOIN attendance a ON a.class_id = c.id
     WHERE c.deleted_at IS NULL AND c.module_id IS NOT NULL
     GROUP BY c.module_id
  ),
  module_feedback AS (
    SELECT module_id,
           round(avg(rating)::numeric, 2) AS avg_rating,
           count(*) FILTER (WHERE submitted_at IS NOT NULL)::int AS feedback_count
      FROM lms_feedback
     WHERE scope = 'module' AND rating IS NOT NULL
     GROUP BY module_id
  )
  SELECT m.id AS module_id, m.name AS module_name,
         m.start_date, m.end_date, m.completed_at, m.completion_note,
         p.id AS program_id, p.name AS course_name,
         u.id AS trainer_id, u.name AS trainer_name,
         COALESCE(mc.classes_planned, 0)   AS classes_planned,
         COALESCE(mc.classes_completed, 0) AS classes_completed,
         COALESCE(mc.classes_ended, 0)     AS classes_ended,
         COALESCE(ma.present_count, 0)     AS present_count,
         COALESCE(ma.attendance_rows, 0)   AS attendance_rows,
         mf.avg_rating, COALESCE(mf.feedback_count, 0) AS feedback_count,
         CASE
           WHEN m.end_date IS NULL THEN 'unscheduled'
           WHEN m.completed_at IS NOT NULL AND m.completed_at::date <= m.end_date THEN 'on_time'
           WHEN m.completed_at IS NOT NULL THEN 'late'
           WHEN m.end_date < current_date THEN 'overdue'
           ELSE 'running'
         END AS status,
         CASE
           WHEN m.end_date IS NULL THEN NULL
           WHEN m.completed_at IS NOT NULL THEN GREATEST(0, m.completed_at::date - m.end_date)
           WHEN m.end_date < current_date THEN current_date - m.end_date
           ELSE 0
         END::int AS days_late
    FROM course_modules m
    JOIN programs p ON p.id = m.program_id
    -- The module's own trainer binding; falls back to the course head so a
    -- module with no dedicated trainer still attributes somewhere.
    LEFT JOIN course_trainers ct
      ON ct.program_id = m.program_id
     AND (ct.module_id = m.id OR (ct.module_id IS NULL AND ct.role = 'head'))
     AND ct.deleted_at IS NULL
    LEFT JOIN users u ON u.id = ct.user_id
    LEFT JOIN module_classes mc    ON mc.module_id = m.id
    LEFT JOIN module_attendance ma ON ma.module_id = m.id
    LEFT JOIN module_feedback mf   ON mf.module_id = m.id
   WHERE m.deleted_at IS NULL
`;

// filters: { trainerId, programId, moduleName } — trainerId is also how a
// trainer is confined to their own rows, so it is applied in SQL rather than
// trusted to the caller filtering afterwards.
export const report = async (tenant, filters = {}) => {
  const where = [];
  const params = [];
  if (filters.trainerId) { params.push(filters.trainerId); where.push(`u.id = $${params.length}`); }
  if (filters.programId) { params.push(filters.programId); where.push(`p.id = $${params.length}`); }
  if (filters.moduleName) { params.push(`%${filters.moduleName}%`); where.push(`m.name ILIKE $${params.length}`); }
  if (filters.trainerName) { params.push(`%${filters.trainerName}%`); where.push(`u.name ILIKE $${params.length}`); }

  const sql = `${BASE} ${where.length ? `AND ${where.join(' AND ')}` : ''}
    ORDER BY u.name NULLS LAST, p.name, m.order_index, m.name`;
  const { rows } = await tenantQuery(tenant, sql, params);
  return rows;
};

// Per-trainer roll-up of the same rows, for the summary cards.
export const summary = async (tenant, filters = {}) => {
  const rows = await report(tenant, filters);
  const byTrainer = new Map();
  for (const r of rows) {
    const key = r.trainer_id ?? 'unassigned';
    if (!byTrainer.has(key)) {
      byTrainer.set(key, {
        trainer_id: r.trainer_id, trainer_name: r.trainer_name ?? 'Unassigned',
        modules: 0, on_time: 0, late: 0, overdue: 0, running: 0, unscheduled: 0,
        classes_planned: 0, classes_completed: 0, present_count: 0, attendance_rows: 0,
        rating_sum: 0, rating_n: 0,
      });
    }
    const t = byTrainer.get(key);
    t.modules += 1;
    t[r.status] += 1;
    t.classes_planned += r.classes_planned;
    t.classes_completed += r.classes_completed;
    t.present_count += r.present_count;
    t.attendance_rows += r.attendance_rows;
    if (r.avg_rating !== null && r.avg_rating !== undefined) {
      t.rating_sum += Number(r.avg_rating) * r.feedback_count;
      t.rating_n += r.feedback_count;
    }
  }
  return [...byTrainer.values()].map((t) => {
    // Only SCHEDULED modules can be judged on time, so unscheduled ones are
    // excluded from the denominator rather than counted as failures.
    const judged = t.on_time + t.late + t.overdue;
    return {
      ...t,
      on_time_pct: judged ? Math.round((t.on_time / judged) * 100) : null,
      attendance_pct: t.attendance_rows ? Math.round((t.present_count / t.attendance_rows) * 100) : null,
      avg_rating: t.rating_n ? Number((t.rating_sum / t.rating_n).toFixed(2)) : null,
    };
  });
};
