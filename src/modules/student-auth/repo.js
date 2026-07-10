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
