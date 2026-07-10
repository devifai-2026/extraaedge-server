// Student authentication — a principal separate from staff users. Students log
// in with email + password; the first password is set via a one-time link
// (minted at Accounts course-confirm, emailed via Brevo with a copy-link
// fallback). Tokens are stored hashed; the raw token only ever lives in the
// emailed/copied URL.
import argon2 from 'argon2';
import * as repo from './repo.js';
import { signAccessToken } from '../../lib/jwt.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { unauthenticated, notFound, validationError, forbidden } from '../../lib/errors.js';
import { sendEmail, linkEmailHtml } from '../../lib/email.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

// Same argon2 profile the staff auth service uses.
const HASH_OPTS = { type: argon2.argon2id, memoryCost: 1 << 16, timeCost: 3, parallelism: 1 };
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // set-password / reset links valid 7 days

// Build the student JWT. type:'student' keeps it strictly distinct from staff
// access tokens — staff middleware rejects it and vice-versa.
const issueStudentToken = (tenant, student) => signAccessToken({
  sub: student.id,
  tenantId: tenant.id,
  tenantSlug: tenant.slug,
  role: 'student',
  type: 'student',
  email: student.email,
});

// Mint a one-time token, persist its hash, and return the RAW token (for the
// link). Reused by course-confirm (initial set-password) and password reset.
export const mintSetPasswordToken = async (tenant, studentId) => {
  const raw = randomToken(32);
  await repo.setResetToken(tenant, studentId, sha256Hex(raw), new Date(Date.now() + TOKEN_TTL_MS));
  return raw;
};

// Generate a short, human-friendly temporary password (easy to read out over
// the phone / paste into WhatsApp). Avoids ambiguous characters (0/O, 1/l/I).
export const generateTempPassword = () => {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const raw = randomToken(24); // base64url random source
  let out = '';
  for (let i = 0; i < 10; i += 1) out += chars[raw.charCodeAt(i) % chars.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`; // e.g. Kp7Rq-mN4xT
};

// Set an initial/temp password directly (no token) and ACTIVATE the student —
// used by Accounts course-confirm so they can hand the student credentials to
// use immediately. Clears any pending set-password token.
export const setInitialPassword = async (tenant, studentId, plainPassword) => {
  const hash = await argon2.hash(plainPassword, HASH_OPTS);
  return repo.setPassword(tenant, studentId, hash); // repo.setPassword also flips status→active + clears token
};

// Absolute set-password URL the student opens. FE route: /student/set-password?token=…
export const setPasswordUrl = (rawToken, tenantSlug) => {
  const base = env.APP_WEB_URL.replace(/\/+$/, '');
  return `${base}/student/set-password?token=${encodeURIComponent(rawToken)}&t=${encodeURIComponent(tenantSlug)}`;
};

// Fire the set-password email (best-effort; the caller keeps a copy-link path).
export const emailSetPasswordLink = async (tenant, student, rawToken) => {
  const url = setPasswordUrl(rawToken, tenant.slug);
  const html = linkEmailHtml({
    heading: `Welcome to ${tenant.company_name || tenant.name}`,
    intro: `Your enrolment is confirmed. Set your password to access your student portal.`,
    buttonLabel: 'Set your password',
    url,
    footer: 'This link expires in 7 days. If you didn’t expect this email, you can ignore it.',
  });
  const r = await sendEmail({ to: { email: student.email, name: student.name }, subject: 'Set your student portal password', html });
  return { url, emailed: r.sent };
};

// Login with email + password → student access token.
export const login = async (tenant, { email, password }) => {
  const student = await repo.findByEmail(tenant, email);
  // Uniform failure (don't leak which half was wrong).
  const fail = () => { throw unauthenticated('Invalid email or password'); };
  if (!student || !student.password_hash) return fail();
  if (student.status !== 'active') throw forbidden('Your account is not active yet. Use your set-password link first.');
  let ok = false;
  try { ok = await argon2.verify(student.password_hash, password); } catch { ok = false; }
  if (!ok) return fail();
  await repo.touchLogin(tenant, student.id);
  return {
    access_token: issueStudentToken(tenant, student),
    student: { id: student.id, name: student.name, email: student.email, program_id: student.program_id },
  };
};

// Complete set-password / reset from a raw token.
export const setPassword = async (tenant, { token, password }) => {
  if (!password || password.length < 8) throw validationError({ password: 'Password must be at least 8 characters' });
  const student = await repo.findByToken(tenant, sha256Hex(token));
  if (!student) throw notFound('This link is invalid or has expired. Ask the accounts team to resend it.');
  const hash = await argon2.hash(password, HASH_OPTS);
  const updated = await repo.setPassword(tenant, student.id, hash);
  return {
    access_token: issueStudentToken(tenant, updated),
    student: { id: updated.id, name: updated.name, email: updated.email, program_id: updated.program_id },
  };
};

// Student-initiated password reset. Always returns ok (don't reveal whether the
// email exists); emails a reset link when it does.
export const requestReset = async (tenant, { email }) => {
  const student = await repo.findByEmail(tenant, email);
  if (student && student.status === 'active') {
    try {
      const raw = await mintSetPasswordToken(tenant, student.id);
      const url = setPasswordUrl(raw, tenant.slug);
      const html = linkEmailHtml({
        heading: 'Reset your password',
        intro: 'We received a request to reset your student portal password.',
        buttonLabel: 'Reset password',
        url,
        footer: 'This link expires in 7 days. If you didn’t request this, you can ignore it.',
      });
      await sendEmail({ to: { email: student.email, name: student.name }, subject: 'Reset your student portal password', html });
    } catch (err) {
      logger.error({ err: err.message }, 'student reset email failed');
    }
  }
  return { ok: true };
};

// Sudo-login as a student (org admin → student panel). No password check —
// mints a student access token for the target. Gated to super_admin at the
// route layer, mirroring the staff sudo-login carve-out.
export const sudoLoginAsStudent = async (tenant, targetStudentId) => {
  const student = await repo.findById(tenant, targetStudentId);
  if (!student) throw notFound('Student not found');
  return {
    access_token: issueStudentToken(tenant, student),
    student: { id: student.id, name: student.name, email: student.email, program_id: student.program_id },
    tenantSlug: tenant.slug,
  };
};

// Current student (for /student-auth/me).
export const me = async (tenant, studentId) => {
  const student = await repo.findById(tenant, studentId);
  if (!student) throw notFound('Student not found');
  return { id: student.id, name: student.name, email: student.email, program_id: student.program_id, status: student.status };
};
