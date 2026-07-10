import { tenantQuery } from '../../db/tenant.js';

const COLS = `
  id, admission_id, program_id, name, email, phone, password_hash, status,
  set_password_token, set_password_expires_at, last_login_at, created_at, updated_at
`;

export const findByEmail = async (tenant, email) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM students WHERE email = $1 AND deleted_at IS NULL LIMIT 1`,
    [email],
  );
  return rows[0] ?? null;
};

export const findById = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM students WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
};

// Look a student up by the (hashed) set-password / reset token, still valid.
export const findByToken = async (tenant, tokenHash) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM students
      WHERE set_password_token = $1 AND deleted_at IS NULL
        AND set_password_expires_at IS NOT NULL
        AND set_password_expires_at > now()
      LIMIT 1`,
    [tokenHash],
  );
  return rows[0] ?? null;
};

// Create a student (idempotent on email within the tenant — returns the
// existing row if one already exists for this admission/email).
export const create = async (tenant, s) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO students (admission_id, program_id, name, email, phone, status,
                           set_password_token, set_password_expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8)
     ON CONFLICT (email) WHERE deleted_at IS NULL DO NOTHING
     RETURNING ${COLS}`,
    [s.admission_id ?? null, s.program_id ?? null, s.name, s.email, s.phone ?? null,
     s.set_password_token ?? null, s.set_password_expires_at ?? null, s.created_by ?? null],
  );
  if (rows[0]) return rows[0];
  return findByEmail(tenant, s.email);
};

export const setResetToken = async (tenant, id, tokenHash, expiresAt) => {
  await tenantQuery(
    tenant,
    `UPDATE students SET set_password_token = $2, set_password_expires_at = $3, updated_at = now()
      WHERE id = $1`,
    [id, tokenHash, expiresAt],
  );
};

// Set the password from a valid token: clears the token, activates the student.
export const setPassword = async (tenant, id, passwordHash) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE students
        SET password_hash = $2, status = 'active',
            set_password_token = NULL, set_password_expires_at = NULL, updated_at = now()
      WHERE id = $1
      RETURNING ${COLS}`,
    [id, passwordHash],
  );
  return rows[0] ?? null;
};

export const touchLogin = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE students SET last_login_at = now() WHERE id = $1`, [id]);
};

// The linked admission's status (on_break / dropped etc.) — gates login so a
// student the accounts team has put on break or dropped can't sign in.
export const admissionStatus = async (tenant, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT a.status FROM students s JOIN admissions a ON a.id = s.admission_id
      WHERE s.id = $1 AND a.deleted_at IS NULL LIMIT 1`,
    [studentId],
  );
  return rows[0]?.status || null;
};

// ---------- Profile ----------
const PROFILE_COLS = `
  id, name, email, phone, status, program_id,
  photo_r2_key, cv_r2_key, cv_filename, dob, address,
  github_url, linkedin_url, portfolio_url, skills, bio
`;

export const getProfile = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${PROFILE_COLS} FROM students WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
};

// Student updates their own editable profile fields (whitelisted).
export const updateProfile = async (tenant, id, input) => {
  const editable = ['phone', 'dob', 'address', 'github_url', 'linkedin_url', 'portfolio_url', 'skills', 'bio', 'photo_r2_key'];
  const sets = []; const params = [];
  for (const k of editable) {
    if (input[k] !== undefined) { params.push(input[k] === '' ? null : input[k]); sets.push(`${k} = $${params.length}`); }
  }
  if (!sets.length) return getProfile(tenant, id);
  params.push(id);
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE students SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $${params.length} AND deleted_at IS NULL RETURNING ${PROFILE_COLS}`,
    params,
  );
  return rows[0] || null;
};

export const setCv = async (tenant, id, r2Key, filename) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE students SET cv_r2_key = $2, cv_filename = $3, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL RETURNING ${PROFILE_COLS}`,
    [id, r2Key, filename ?? null],
  );
  return rows[0] || null;
};

// Trainer view: a student's profile IF the trainer teaches the student's
// course (course_trainers membership) or is an admin. Returns null if not
// allowed so the caller can 403.
export const getProfileForTrainer = async (tenant, studentId, trainerUserId, isAdmin) => {
  if (isAdmin) return getProfile(tenant, studentId);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${PROFILE_COLS} FROM students s
      WHERE s.id = $1 AND s.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM course_trainers ct
           WHERE ct.program_id = s.program_id AND ct.user_id = $2 AND ct.deleted_at IS NULL)`,
    [studentId, trainerUserId],
  );
  return rows[0] || null;
};
