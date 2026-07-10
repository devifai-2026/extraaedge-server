import { tenantQuery } from '../../db/tenant.js';

export const createThread = async (tenant, { program_id, student_id, title, body, mentions }) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO forum_threads (program_id, student_id, title, body, mentions)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [program_id, student_id, title, body, mentions ?? []],
  );
  return rows[0];
};

// Feed for a program with author name + reply count. `mineStudentId` marks the
// student's own threads.
export const listThreads = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT th.id, th.title, th.body, th.status, th.mentions, th.created_at,
            s.name AS student_name,
            (SELECT count(*)::int FROM forum_replies r WHERE r.thread_id = th.id AND r.deleted_at IS NULL) AS reply_count
       FROM forum_threads th
       JOIN students s ON s.id = th.student_id
      WHERE th.program_id = $1 AND th.deleted_at IS NULL
      ORDER BY th.created_at DESC`,
    [programId],
  );
  return rows;
};

export const getThread = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM forum_threads WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] || null;
};

export const listReplies = async (tenant, threadId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT r.id, r.body, r.author_kind, r.created_at,
            COALESCE(u.name, s.name) AS author_name
       FROM forum_replies r
       LEFT JOIN users u ON u.id = r.author_user_id
       LEFT JOIN students s ON s.id = r.author_student_id
      WHERE r.thread_id = $1 AND r.deleted_at IS NULL
      ORDER BY r.created_at`,
    [threadId],
  );
  return rows;
};

export const addReply = async (tenant, threadId, author, body) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO forum_replies (thread_id, author_kind, author_user_id, author_student_id, body)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [threadId, author.kind,
     author.kind === 'user' ? author.id : null,
     author.kind === 'student' ? author.id : null, body],
  );
  // A trainer reply flips the thread to 'answered'.
  if (author.kind === 'user') {
    await tenantQuery(tenant, `UPDATE forum_threads SET status = 'answered', updated_at = now() WHERE id = $1 AND status = 'open'`, [threadId]);
  }
  return rows[0];
};

export const studentProgram = async (tenant, studentId) => {
  const { rows } = await tenantQuery(tenant, `SELECT program_id FROM students WHERE id = $1 AND deleted_at IS NULL`, [studentId]);
  return rows[0]?.program_id || null;
};

// Trainers on a course (for the @mention picker + default notify targets).
export const courseTrainerUserIds = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT DISTINCT user_id FROM course_trainers WHERE program_id = $1 AND deleted_at IS NULL`,
    [programId],
  );
  return rows.map((r) => r.user_id);
};

export const courseTrainers = async (tenant, programId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ct.user_id, u.name, ct.role FROM course_trainers ct JOIN users u ON u.id = ct.user_id
      WHERE ct.program_id = $1 AND ct.deleted_at IS NULL ORDER BY (ct.role='head') DESC, u.name`,
    [programId],
  );
  return rows;
};
