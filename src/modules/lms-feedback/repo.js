import { tenantQuery } from '../../db/tenant.js';

// What a student still owes feedback on. Class feedback is asked ONLY of
// students marked present — someone who missed the class has nothing to say
// about it, and asking would both annoy them and pollute the trainer's score.
//
// Module feedback is asked once a module is complete and the student attended
// at least one of its classes, for the same reason.
export const pending = async (tenant, studentId) => {
  const { rows: classes } = await tenantQuery(
    tenant,
    `SELECT c.id AS class_id, c.title, c.ends_at, c.trainer_id,
            m.name AS module_name, u.name AS trainer_name,
            COALESCE(f.dismissed_count, 0) AS dismissed_count
       FROM batch_students bs
       JOIN classes c ON c.batch_id = bs.batch_id AND c.deleted_at IS NULL
       JOIN attendance att ON att.class_id = c.id AND att.student_id = bs.student_id
       LEFT JOIN course_modules m ON m.id = c.module_id
       LEFT JOIN users u ON u.id = c.trainer_id
       LEFT JOIN lms_feedback f
         ON f.scope = 'class' AND f.class_id = c.id AND f.student_id = bs.student_id
      WHERE bs.student_id = $1 AND bs.deleted_at IS NULL
        AND c.ended_at IS NOT NULL
        AND att.status = 'present'
        AND f.submitted_at IS NULL
      ORDER BY c.ends_at DESC
      LIMIT 5`,
    [studentId],
  );

  const { rows: modules } = await tenantQuery(
    tenant,
    `SELECT DISTINCT m.id AS module_id, m.name AS module_name, m.completed_at,
            COALESCE(f.dismissed_count, 0) AS dismissed_count
       FROM batch_students bs
       JOIN classes c ON c.batch_id = bs.batch_id AND c.deleted_at IS NULL
       JOIN course_modules m ON m.id = c.module_id AND m.deleted_at IS NULL
       JOIN attendance att ON att.class_id = c.id AND att.student_id = bs.student_id
       LEFT JOIN lms_feedback f
         ON f.scope = 'module' AND f.module_id = m.id AND f.student_id = bs.student_id
      WHERE bs.student_id = $1 AND bs.deleted_at IS NULL
        AND m.completed_at IS NOT NULL
        AND att.status = 'present'
        AND f.submitted_at IS NULL
      ORDER BY m.completed_at DESC
      LIMIT 5`,
    [studentId],
  );
  return { classes, modules };
};

// Staff-facing: the submitted feedback itself, newest first.
//
// Student names ARE included. Feedback here is attached to attendance and a
// named trainer, so it was never anonymous in the data model — presenting it as
// anonymous in the UI while storing the name would be the worse outcome. If it
// should be anonymous to trainers later, drop the name in the service for that
// role rather than here, so the admin view keeps it.
export const staffList = async (tenant, filters = {}) => {
  const where = ['f.submitted_at IS NOT NULL'];
  const params = [];
  if (filters.trainerId) { params.push(filters.trainerId); where.push(`f.trainer_id = $${params.length}`); }
  if (filters.programId) { params.push(filters.programId); where.push(`p.id = $${params.length}`); }
  if (filters.scope) { params.push(filters.scope); where.push(`f.scope = $${params.length}`); }

  const { rows } = await tenantQuery(
    tenant,
    `SELECT f.id, f.scope, f.rating, f.pace_rating, f.clarity_rating, f.comment,
            f.submitted_at,
            s.name AS student_name,
            u.name AS trainer_name, f.trainer_id,
            c.title AS class_title, c.starts_at,
            m.name AS module_name,
            p.name AS course_name
       FROM lms_feedback f
       JOIN students s ON s.id = f.student_id
       LEFT JOIN users u ON u.id = f.trainer_id
       LEFT JOIN classes c ON c.id = f.class_id
       LEFT JOIN course_modules m ON m.id = COALESCE(f.module_id, c.module_id)
       LEFT JOIN programs p ON p.id = m.program_id
      WHERE ${where.join(' AND ')}
      ORDER BY f.submitted_at DESC
      LIMIT 500`,
    params,
  );
  return rows;
};

// Upsert, because a dismissal writes the same row the submission later fills
// in. submitted_at is what makes it count as answered.
export const submit = async (tenant, studentId, input) => {
  const isClass = input.scope === 'class';
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO lms_feedback
       (scope, class_id, module_id, student_id, trainer_id, rating, pace_rating, clarity_rating, comment, submitted_at)
     VALUES ($1,$2,$3,$4,
             COALESCE($5, (SELECT trainer_id FROM classes WHERE id = $2)),
             $6,$7,$8,$9, now())
     ON CONFLICT ${isClass ? '(class_id, student_id) WHERE scope = \'class\'' : '(module_id, student_id) WHERE scope = \'module\''}
     DO UPDATE SET rating = EXCLUDED.rating, pace_rating = EXCLUDED.pace_rating,
                   clarity_rating = EXCLUDED.clarity_rating, comment = EXCLUDED.comment,
                   submitted_at = now(), updated_at = now()
     RETURNING *`,
    [input.scope, input.class_id ?? null, input.module_id ?? null, studentId,
      input.trainer_id ?? null, input.rating, input.pace_rating ?? null,
      input.clarity_rating ?? null, input.comment ?? null],
  );
  return rows[0];
};

// "Skippable once, but it comes back." Bumps the counter without setting
// submitted_at, so the prompt reappears on the next login.
export const dismiss = async (tenant, studentId, input) => {
  const isClass = input.scope === 'class';
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO lms_feedback (scope, class_id, module_id, student_id, dismissed_count)
     VALUES ($1,$2,$3,$4,1)
     ON CONFLICT ${isClass ? '(class_id, student_id) WHERE scope = \'class\'' : '(module_id, student_id) WHERE scope = \'module\''}
     DO UPDATE SET dismissed_count = lms_feedback.dismissed_count + 1, updated_at = now()
     RETURNING dismissed_count`,
    [input.scope, input.class_id ?? null, input.module_id ?? null, studentId],
  );
  return rows[0];
};
