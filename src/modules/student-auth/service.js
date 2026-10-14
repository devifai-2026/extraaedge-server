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
import { presignUpload } from '../uploads/service.js';
import { getDownloadSignedUrl } from '../../lib/r2.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

// Same argon2 profile the staff auth service uses.
const HASH_OPTS = { type: argon2.argon2id, memoryCost: 1 << 16, timeCost: 3, parallelism: 1 };
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // set-password / reset links valid 7 days

// Build the student JWT. type:'student' keeps it strictly distinct from staff
// access tokens — staff middleware rejects it and vice-versa.
const issueStudentToken = (tenant, student, extraClaims = {}, opts = undefined) => signAccessToken({
  sub: student.id,
  tenantId: tenant.id,
  tenantSlug: tenant.slug,
  role: 'student',
  type: 'student',
  email: student.email,
  ...extraClaims,
}, opts);

// A branch manager looking at a student's LMS gets 30 minutes, not a normal
// session. Long enough to see what the student sees, short enough that the
// window closes on its own.
const STUDENT_VIEW_AS_TTL_SECONDS = 30 * 60;

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

// The student portal's login URL for this tenant.
export const studentLoginUrl = (tenantSlug) => {
  const base = env.APP_WEB_URL.replace(/\/+$/, '');
  return `${base}/student/login?t=${encodeURIComponent(tenantSlug)}`;
};

// Welcome + onboarding email, sent at course-confirm when the credentials are
// actually minted.
//
// WHY HERE AND NOWHERE ELSE: the temp password is never stored in plaintext —
// confirmCourse returns it once and it is gone. So this is the only moment the
// student can be told their password; a nightly job or a "resend" button
// cannot reconstruct it (a re-confirm issues a NEW one).
//
// Best-effort by design: sendEmail never throws, and the caller still returns
// the credentials on screen for Accounts to share by WhatsApp/call. Email
// failing must never fail course-confirm or lose the credentials.
export const emailWelcomeCredentials = async (tenant, student, tempPassword, { programName } = {}) => {
  const url = studentLoginUrl(tenant.slug);
  const brand = tenant.company_name || tenant.brand_name || tenant.name;
  const row = (label, value) => `
    <tr>
      <td style="padding:6px 12px 6px 0;font-size:13px;color:#64748b;white-space:nowrap">${label}</td>
      <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600">${value}</td>
    </tr>`;
  const html = `
  <div style="font-family:'Segoe UI',system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
    <h2 style="font-size:18px;margin:0 0 12px">Welcome to ${brand}, ${student.name}</h2>
    <p style="font-size:14px;line-height:1.6;color:#334155;margin:0 0 18px">
      Your enrolment${programName ? ` for <strong>${programName}</strong>` : ''} is confirmed and your
      student portal is ready. Here is everything you need to get started.
    </p>

    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin:0 0 20px">
      <div style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">Your login</div>
      <table style="border-collapse:collapse">
        ${row('Email', student.email)}
        ${row('Temporary password', `<code style="background:#fff;border:1px solid #e2e8f0;border-radius:4px;padding:2px 6px">${tempPassword}</code>`)}
      </table>
      <p style="font-size:12px;color:#64748b;margin:12px 0 0">
        Please change this password after your first sign-in.
      </p>
    </div>

    <p style="margin:0 0 22px">
      <a href="${url}" style="display:inline-block;background:#E53935;color:#fff;text-decoration:none;
         padding:11px 22px;border-radius:8px;font-size:14px;font-weight:600">Sign in to your portal</a>
    </p>

    <div style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.6px;margin:0 0 8px">What you can do there</div>
    <ul style="font-size:13.5px;line-height:1.75;color:#334155;margin:0 0 20px;padding-left:18px">
      <li><strong>Classes</strong> — your schedule, join links and class recordings</li>
      <li><strong>Materials</strong> — notes and resources shared by your trainer</li>
      <li><strong>Tests &amp; projects</strong> — assignments to attempt and submit</li>
      <li><strong>Doubt forum</strong> — ask your trainer a question any time</li>
      <li><strong>Certificate</strong> — available once you complete the course</li>
    </ul>

    <p style="font-size:12px;color:#64748b;margin:0 0 6px">Or paste this link into your browser:</p>
    <p style="font-size:12px;color:#2563eb;word-break:break-all;margin:0 0 20px">${url}</p>
    <p style="font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:12px">
      Didn't expect this email? Please contact the ${brand} team.
    </p>
  </div>`;
  const r = await sendEmail({
    to: { email: student.email, name: student.name },
    subject: `Welcome to ${brand} — your student portal login`,
    html,
  });
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
  // Block login if the accounts team has put the enrolment on break or dropped
  // it — with a clear, distinct message per case.
  const admStatus = await repo.admissionStatus(tenant, student.id);
  if (admStatus === 'on_break') {
    throw forbidden('Your enrolment is currently on break. Please contact the accounts team to resume access.');
  }
  if (admStatus === 'dropped') {
    throw forbidden('Your enrolment has been discontinued. Please contact the accounts team for details.');
  }
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

// READ-ONLY student sudo, for a branch manager.
//
// Distinct from sudoLoginAsStudent above, which is the super_admin's full
// session. The difference is one claim, `readOnly: true`, which
// studentReadOnly (middleware/studentReadOnly.js) turns into a deny on every
// write method. It matters because a student account is not a queue of work
// like a counsellor's — it is one person's grades, submissions and forum
// posts. A BM needs to SEE that to support them; nothing about supporting
// them requires submitting a test in their name, and an action taken through
// a full student token would be indistinguishable from the student's own.
//
// The token is also short-lived and carries no refresh, matching the staff
// view-as: a look, not a login.
export const viewAsStudent = async (tenant, targetStudentId) => {
  const student = await repo.findById(tenant, targetStudentId);
  if (!student) throw notFound('Student not found');
  return {
    access_token: issueStudentToken(
      tenant,
      student,
      { readOnly: true },
      { ttlSeconds: STUDENT_VIEW_AS_TTL_SECONDS },
    ),
    read_only: true,
    expires_in: STUDENT_VIEW_AS_TTL_SECONDS,
    student: { id: student.id, name: student.name, email: student.email, program_id: student.program_id },
    tenantSlug: tenant.slug,
  };
};

// Current student (for /student-auth/me).
export const me = async (tenant, studentId) => {
  const student = await repo.findById(tenant, studentId);
  if (!student) throw notFound('Student not found');
  return {
    id: student.id, name: student.name, email: student.email, program_id: student.program_id, status: student.status,
    // Tenant branding so the student shell can render the logo on first paint
    // (not only after the dashboard fetch resolves).
    tenant: {
      name: tenant.company_name || tenant.brand_name || tenant.name,
      logo_url: tenant.logo_url || null,
      brand_primary_color: tenant.brand_primary_color || '#E53935',
    },
  };
};

// ---------- Profile ----------
const withUrls = async (tenant, p) => {
  if (!p) return p;
  const sign = async (key, downloadAs) => (key ? getDownloadSignedUrl({ key, expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS, downloadAs }).catch(() => null) : null);
  return {
    ...p,
    photo_url: await sign(p.photo_r2_key),
    cv_url: await sign(p.cv_r2_key, p.cv_filename || 'cv.pdf'),
  };
};

export const getProfile = async (tenant, studentId) => {
  const p = await repo.getProfile(tenant, studentId);
  if (!p) throw notFound('Student not found');
  return withUrls(tenant, p);
};

export const updateProfile = async (tenant, studentId, input) => {
  const p = await repo.updateProfile(tenant, studentId, input);
  return withUrls(tenant, p);
};

// Presign a student upload (photo | cv). Reuses the uploads presign (it only
// needs the tenant); purpose maps to a GCS folder + size ceiling.
export const presign = async (tenant, studentId, input) => {
  const purpose = input.kind === 'cv' ? 'note_attachment' : 'admission_photo'; // reuse existing size-capped purposes
  return presignUpload(tenant, { id: studentId }, {
    purpose, content_type: input.content_type, size_bytes: input.size_bytes, filename: input.filename,
  });
};

export const setCv = async (tenant, studentId, r2Key, filename) => {
  const p = await repo.setCv(tenant, studentId, r2Key, filename);
  return withUrls(tenant, p);
};

// Trainer view of a student's profile (must teach the student's course).
export const trainerViewProfile = async (tenant, actor, studentId) => {
  const isAdmin = actor?.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN || actor?.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER;
  const p = await repo.getProfileForTrainer(tenant, studentId, actor?.id, isAdmin);
  if (!p) throw forbidden('You cannot view this student.');
  return withUrls(tenant, p);
};
