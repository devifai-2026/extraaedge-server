// Placement — companies, job openings + posters, criteria-based firing, and
// applications. Staff access = super_admin / branch_manager / placement (+ HR
// read-ish via admin). Branch-scoped: the criteria audience + firing honor the
// active branch (a student's branch via admission→lead→branch), validated
// against the placement user's branch memberships.
import * as repo from './repo.js';
import * as coursesRepo from '../courses/repo.js';
import { getDownloadSignedUrl } from '../../lib/r2.js';
import { env } from '../../config/env.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES, LMS_TENANT_ROLES } from '../../config/constants.js';
import { pushStudentNotification } from '../student-notifications/service.js';

const isAdmin = (actor) => actor?.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN || actor?.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER;
// The active branch a placement user may scope to (admins → any; else validated
// against their user_branches). Null = no branch filter.
const resolveBranch = async (tenant, actor, branchId) => {
  if (!branchId) return null;
  if (isAdmin(actor)) return branchId;
  const allowed = await coursesRepo.branchesForUser(tenant, actor?.id);
  return allowed.some((b) => b.id === branchId) ? branchId : null;
};

const signLogo = async (row) => ({ ...row, logo_url: row.logo_r2_key ? await getDownloadSignedUrl({ key: row.logo_r2_key, expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS }).catch(() => null) : null });
const signPoster = async (row) => ({ ...row, poster_url: row.poster_r2_key ? await getDownloadSignedUrl({ key: row.poster_r2_key, expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS }).catch(() => null) : null });

// ---------- Companies ----------
export const listCompanies = async (tenant) => Promise.all((await repo.listCompanies(tenant)).map(signLogo));
export const createCompany = async (tenant, actor, input) => repo.createCompany(tenant, input, actor?.id);
export const updateCompany = async (tenant, actor, id, input) => {
  const row = await repo.updateCompany(tenant, id, input);
  if (!row) throw notFound('Company not found');
  return row;
};
export const deleteCompany = async (tenant, actor, id) => { await repo.deleteCompany(tenant, id); return { ok: true }; };
export const bulkCreateCompanies = async (tenant, actor, rows) => {
  if (!Array.isArray(rows) || !rows.length) throw validationError({ rows: 'No companies to import' });
  const n = await repo.bulkCreateCompanies(tenant, rows, actor?.id);
  return { inserted: n };
};

// ---------- Openings ----------
export const listOpenings = async (tenant, status) => Promise.all((await repo.listOpenings(tenant, { status })).map(signPoster));
export const createOpening = async (tenant, actor, input) => {
  if (!input.company_id || !input.title) throw validationError({ opening: 'Company and title are required' });
  return repo.createOpening(tenant, input, actor?.id);
};
export const setOpeningStatus = async (tenant, actor, id, status) => {
  const row = await repo.setOpeningStatus(tenant, id, status);
  if (!row) throw notFound('Opening not found');
  return row;
};
export const deleteOpening = async (tenant, actor, id) => { await repo.deleteOpening(tenant, id); return { ok: true }; };
export const counts = async (tenant) => repo.counts(tenant);

// ---------- Criteria firing ----------
export const previewAudience = async (tenant, actor, openingId, branchId) => {
  const o = await repo.getOpening(tenant, openingId);
  if (!o) throw notFound('Opening not found');
  const branch = await resolveBranch(tenant, actor, branchId);
  const matched = await repo.matchAudience(tenant, { programId: o.program_id, criteria: o.criteria || {}, branchId: branch });
  return { count: matched.length, students: matched };
};

export const fire = async (tenant, actor, openingId, branchId) => {
  const o = await repo.getOpening(tenant, openingId);
  if (!o) throw notFound('Opening not found');
  if (o.status !== 'open') throw validationError({ opening: 'Opening is closed' });
  const branch = await resolveBranch(tenant, actor, branchId);
  const matched = await repo.matchAudience(tenant, { programId: o.program_id, criteria: o.criteria || {}, branchId: branch });
  const ids = matched.map((m) => m.id);
  const fired = await repo.fireToStudents(tenant, openingId, ids, actor?.id);
  for (const sid of ids) {
    pushStudentNotification(tenant, sid, { type: 'job_opening', message: `New job opening: ${o.title} @ ${o.company_name}`, link: '/student/jobs', metadata: { opening_id: openingId } });
  }
  return { matched: ids.length, fired };
};

// ---------- Applications ----------
export const listApplications = async (tenant, actor, openingId) => repo.listApplications(tenant, openingId);
export const setApplicationStatus = async (tenant, actor, applicationId, status, note) => {
  const a = await repo.applicationById(tenant, applicationId);
  if (!a) throw notFound('Application not found');
  return repo.setApplicationStatus(tenant, applicationId, status, note);
};

// ---------- Student ----------
export const studentOpenings = async (tenant, studentId) => Promise.all((await repo.studentOpenings(tenant, studentId)).map(signPoster).map((p) => p));
export const studentFeed = async (tenant, studentId) => {
  const [openings, posters] = await Promise.all([
    Promise.all((await repo.studentOpenings(tenant, studentId)).map(signPoster)),
    Promise.all((await repo.posterFeed(tenant)).map(signPoster)),
  ]);
  return { openings, posters };
};
export const applyToOpening = async (tenant, studentId, openingId) => {
  const o = await repo.getOpening(tenant, openingId);
  if (!o) throw notFound('Opening not found');
  return repo.applyToOpening(tenant, openingId, studentId);
};
