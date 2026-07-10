import { tenantQuery, tenantTx } from '../../db/tenant.js';

// ---------- Recordings ----------
export const addRecording = async (tenant, classId, { r2_key, label }, actorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO class_recordings (class_id, r2_key, label, uploaded_by) VALUES ($1,$2,$3,$4) RETURNING *`,
    [classId, r2_key, label ?? null, actorId ?? null],
  );
  return rows[0];
};

export const listRecordings = async (tenant, classId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, class_id, r2_key, label, created_at FROM class_recordings WHERE class_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [classId],
  );
  return rows;
};

export const getRecording = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM class_recordings WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] || null;
};

// Classes for a program/batch that have ENDED but have no recording yet — the
// "missed recording" prompt source for a trainer.
export const classesMissingRecording = async (tenant, trainerId, isAdmin) => {
  // Trainers see only classes on their courses; admins see all.
  const params = [];
  let scope = '';
  if (!isAdmin) {
    params.push(trainerId);
    scope = `AND EXISTS (SELECT 1 FROM course_trainers ct WHERE ct.program_id = c.program_id AND ct.user_id = $${params.length} AND ct.deleted_at IS NULL)`;
  }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT c.id, c.title, c.batch_id, b.name AS batch_name, c.ended_at
       FROM classes c JOIN batches b ON b.id = c.batch_id
      WHERE c.deleted_at IS NULL AND c.ended_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM class_recordings r WHERE r.class_id = c.id AND r.deleted_at IS NULL)
        ${scope}
      ORDER BY c.ended_at DESC LIMIT 20`,
    params,
  );
  return rows;
};

// A student may view a recording only if their batch membership's
// recordings_from cutoff allows it (NULL cutoff = only classes on/after they
// joined; a set cutoff shares the back-catalog from that date). We compare the
// class start date against the cutoff / join time.
export const studentMayViewRecording = async (tenant, recordingId, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT 1
       FROM class_recordings r
       JOIN classes c ON c.id = r.class_id
       JOIN batch_students bs ON bs.batch_id = c.batch_id AND bs.student_id = $2 AND bs.deleted_at IS NULL
      WHERE r.id = $1 AND r.deleted_at IS NULL
        AND c.starts_at >= COALESCE(bs.recordings_from, bs.joined_at)
      LIMIT 1`,
    [recordingId, studentId],
  );
  return rows.length > 0;
};

// Student's visible recordings across their batch, honoring the cutoff.
export const studentRecordings = async (tenant, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT r.id, r.label, r.created_at, c.id AS class_id, c.title AS class_title, c.starts_at, m.name AS module_name
       FROM batch_students bs
       JOIN classes c ON c.batch_id = bs.batch_id AND c.deleted_at IS NULL
       JOIN class_recordings r ON r.class_id = c.id AND r.deleted_at IS NULL
       LEFT JOIN course_modules m ON m.id = c.module_id
      WHERE bs.student_id = $1 AND bs.deleted_at IS NULL
        AND c.starts_at >= COALESCE(bs.recordings_from, bs.joined_at)
      ORDER BY c.starts_at DESC`,
    [studentId],
  );
  return rows;
};

// ---------- Announcements ----------
export const createAnnouncement = async (tenant, { program_id, batch_id, class_id, title, body, auto_source }, actorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO announcements (program_id, batch_id, class_id, title, body, author_user_id, auto_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [program_id, batch_id ?? null, class_id ?? null, title ?? null, body, actorId ?? null, auto_source ?? null],
  );
  return rows[0];
};

// Feed for a program (optionally a batch). viewerKind + viewerId toggle the
// "liked_by_me" flag.
export const listAnnouncements = async (tenant, { programId, batchId }, viewer) => {
  const params = [programId];
  let where = 'a.program_id = $1 AND a.deleted_at IS NULL';
  if (batchId) { params.push(batchId); where += ` AND (a.batch_id IS NULL OR a.batch_id = $${params.length})`; }
  // liked-by-me subquery
  let likedExpr = 'false';
  if (viewer?.kind === 'user') { params.push(viewer.id); likedExpr = `EXISTS (SELECT 1 FROM announcement_likes l WHERE l.announcement_id = a.id AND l.user_id = $${params.length})`; }
  else if (viewer?.kind === 'student') { params.push(viewer.id); likedExpr = `EXISTS (SELECT 1 FROM announcement_likes l WHERE l.announcement_id = a.id AND l.student_id = $${params.length})`; }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT a.id, a.title, a.body, a.class_id, a.auto_source, a.created_at,
            u.name AS author_name,
            (SELECT count(*)::int FROM announcement_likes l WHERE l.announcement_id = a.id) AS like_count,
            (SELECT count(*)::int FROM announcement_comments c WHERE c.announcement_id = a.id AND c.deleted_at IS NULL) AS comment_count,
            ${likedExpr} AS liked_by_me
       FROM announcements a
       LEFT JOIN users u ON u.id = a.author_user_id
      WHERE ${where}
      ORDER BY a.created_at DESC`,
    params,
  );
  return rows;
};

export const getAnnouncement = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT * FROM announcements WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] || null;
};

export const listComments = async (tenant, announcementId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT c.id, c.body, c.author_kind, c.created_at,
            COALESCE(u.name, s.name) AS author_name
       FROM announcement_comments c
       LEFT JOIN users u ON u.id = c.author_user_id
       LEFT JOIN students s ON s.id = c.author_student_id
      WHERE c.announcement_id = $1 AND c.deleted_at IS NULL
      ORDER BY c.created_at`,
    [announcementId],
  );
  return rows;
};

export const addComment = async (tenant, announcementId, author, body) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO announcement_comments (announcement_id, author_kind, author_user_id, author_student_id, body)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [announcementId, author.kind,
     author.kind === 'user' ? author.id : null,
     author.kind === 'student' ? author.id : null, body],
  );
  return rows[0];
};

// Toggle a like; returns { liked }.
export const toggleLike = async (tenant, announcementId, actor) =>
  tenantTx(tenant, async (client) => {
    const col = actor.kind === 'user' ? 'user_id' : 'student_id';
    const { rows: existing } = await client.query(
      `SELECT id FROM announcement_likes WHERE announcement_id = $1 AND ${col} = $2`,
      [announcementId, actor.id],
    );
    if (existing[0]) {
      await client.query(`DELETE FROM announcement_likes WHERE id = $1`, [existing[0].id]);
      return { liked: false };
    }
    await client.query(
      `INSERT INTO announcement_likes (announcement_id, ${col}) VALUES ($1,$2)`,
      [announcementId, actor.id],
    );
    return { liked: true };
  });

// Which program does a student belong to (for feed scoping)?
export const studentProgram = async (tenant, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.program_id,
            (SELECT bs.batch_id FROM batch_students bs WHERE bs.student_id = s.id AND bs.deleted_at IS NULL LIMIT 1) AS batch_id
       FROM students s WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [studentId],
  );
  return rows[0] || null;
};

// Is a student allowed to view/comment on an announcement (their program)?
export const studentCanSeeAnnouncement = async (tenant, announcementId, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT 1 FROM announcements a JOIN students s ON s.id = $2
      WHERE a.id = $1 AND a.deleted_at IS NULL AND a.program_id = s.program_id LIMIT 1`,
    [announcementId, studentId],
  );
  return rows.length > 0;
};
