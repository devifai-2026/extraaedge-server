// Placement — companies, job openings + posters, criteria-based firing, and
// applications. Staff access = super_admin / branch_manager / placement (+ HR
// read-ish via admin). Branch-scoped: the criteria audience + firing honor the
// active branch (a student's branch via admission→lead→branch), validated
// against the placement user's branch memberships.
import * as repo from './repo.js';
import * as coursesRepo from '../courses/repo.js';
import * as assessmentsRepo from '../assessments/repo.js';
import * as capstoneRepo from '../capstone/repo.js';
import * as interviewsRepo from '../interviews/repo.js';
import * as learningRepo from '../learning/repo.js';
import { getDownloadSignedUrl } from '../../lib/r2.js';
import { env } from '../../config/env.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES, LMS_TENANT_ROLES } from '../../config/constants.js';
import { pushStudentNotification } from '../student-notifications/service.js';

const isSuper = (actor) => actor?.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN;
const isAdmin = (actor) => isSuper(actor) || actor?.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER;

// The set of branches a caller's READS should be scoped to (null = all
// branches; an array restricts). super_admin with no pick → null (all). Any
// other actor (branch_manager / placement) with no pick → their OWN branch
// memberships (so a branch officer never sees another branch by default,
// mirroring users/service). A specific `branchId` is honored only if the actor
// may access it; a super_admin may pick any branch.
const resolveScope = async (tenant, actor, branchId) => {
  const mine = isSuper(actor) ? null : (await coursesRepo.branchesForUser(tenant, actor?.id)).map((b) => b.id);
  if (branchId) {
    if (isSuper(actor)) return [branchId];
    return mine && mine.includes(branchId) ? [branchId] : (mine && mine.length ? mine : []);
  }
  return mine && mine.length ? mine : null; // null → all (super_admin, or branch-bound user with no memberships)
};

// A single branch id to STAMP on newly-created companies/openings: the picked
// branch if valid, else the actor's (first) own branch, else null (tenant-wide).
const resolveWriteBranch = async (tenant, actor, branchId) => {
  const scope = await resolveScope(tenant, actor, branchId);
  if (branchId && scope && scope.includes(branchId)) return branchId;
  return scope && scope.length === 1 ? scope[0] : (scope && scope.length ? scope[0] : null);
};

// The single active branch to scope firing/audience to: the picked branch (if
// allowed) or the actor's sole branch. Null = tenant-wide (super_admin).
const resolveFireBranch = async (tenant, actor, branchId) => {
  const scope = await resolveScope(tenant, actor, branchId);
  if (!scope) return null; // super_admin, all branches
  if (branchId && scope.includes(branchId)) return branchId;
  return scope.length === 1 ? scope[0] : null; // multi-branch user with no pick → no extra branch filter
};

const signLogo = async (row) => ({ ...row, logo_url: row.logo_r2_key ? await getDownloadSignedUrl({ key: row.logo_r2_key, expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS }).catch(() => null) : null });
const signPoster = async (row) => ({ ...row, poster_url: row.poster_r2_key ? await getDownloadSignedUrl({ key: row.poster_r2_key, expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS }).catch(() => null) : null });

// ---------- Companies ----------
export const listCompanies = async (tenant, actor, branchId) => {
  const scope = await resolveScope(tenant, actor, branchId);
  return Promise.all((await repo.listCompanies(tenant, scope)).map(signLogo));
};
export const createCompany = async (tenant, actor, input) => {
  const branch_id = await resolveWriteBranch(tenant, actor, input.branch_id);
  return repo.createCompany(tenant, { ...input, branch_id }, actor?.id);
};
export const updateCompany = async (tenant, actor, id, input) => {
  const row = await repo.updateCompany(tenant, id, input);
  if (!row) throw notFound('Company not found');
  return row;
};
export const deleteCompany = async (tenant, actor, id) => { await repo.deleteCompany(tenant, id); return { ok: true }; };
export const bulkCreateCompanies = async (tenant, actor, rows, branchId) => {
  if (!Array.isArray(rows) || !rows.length) throw validationError({ rows: 'No companies to import' });
  const branch = await resolveWriteBranch(tenant, actor, branchId);
  const n = await repo.bulkCreateCompanies(tenant, rows, actor?.id, branch);
  return { inserted: n };
};

// ---------- Openings ----------
export const listOpenings = async (tenant, actor, status, branchId) => {
  const scope = await resolveScope(tenant, actor, branchId);
  return Promise.all((await repo.listOpenings(tenant, { status, branchScope: scope })).map(signPoster));
};
export const createOpening = async (tenant, actor, input) => {
  if (!input.company_id || !input.title) throw validationError({ opening: 'Company and title are required' });
  const branch_id = await resolveWriteBranch(tenant, actor, input.branch_id);
  return repo.createOpening(tenant, { ...input, branch_id }, actor?.id);
};
export const setOpeningStatus = async (tenant, actor, id, status) => {
  const row = await repo.setOpeningStatus(tenant, id, status);
  if (!row) throw notFound('Opening not found');
  return row;
};
export const deleteOpening = async (tenant, actor, id) => { await repo.deleteOpening(tenant, id); return { ok: true }; };
export const analytics = async (tenant, actor, branchId) => {
  const scope = await resolveScope(tenant, actor, branchId);
  return repo.analytics(tenant, scope);
};
export const counts = async (tenant, actor, branchId) => {
  const scope = await resolveScope(tenant, actor, branchId);
  return repo.counts(tenant, scope);
};
// Modules of a program (for the criteria builder's "module completed" option).
export const programModules = async (tenant, programId) => {
  if (!programId) return [];
  const mods = await coursesRepo.listModules(tenant, programId);
  return mods.map((m) => ({ id: m.id, name: m.name }));
};

// ---------- Criteria firing ----------
// The audience branch defaults to the opening's own branch (so firing a Pune
// opening only reaches Pune students) unless an explicit allowed branch is
// picked; a super_admin with no pick fires tenant-wide.
const audienceBranch = async (tenant, actor, opening, branchId) => {
  const picked = await resolveFireBranch(tenant, actor, branchId);
  if (picked) return picked;
  // No explicit/derived actor branch → fall back to the opening's own branch.
  return opening.branch_id || null;
};

export const previewAudience = async (tenant, actor, openingId, branchId) => {
  const o = await repo.getOpening(tenant, openingId);
  if (!o) throw notFound('Opening not found');
  const branch = await audienceBranch(tenant, actor, o, branchId);
  const matched = await repo.matchAudience(tenant, { programId: o.program_id, criteria: o.criteria || {}, branchId: branch });
  return { count: matched.length, students: matched };
};

export const fire = async (tenant, actor, openingId, branchId) => {
  const o = await repo.getOpening(tenant, openingId);
  if (!o) throw notFound('Opening not found');
  if (o.status !== 'open') throw validationError({ opening: 'Opening is closed' });
  const branch = await audienceBranch(tenant, actor, o, branchId);
  const matched = await repo.matchAudience(tenant, { programId: o.program_id, criteria: o.criteria || {}, branchId: branch });
  const ids = matched.map((m) => m.id);
  const fired = await repo.fireToStudents(tenant, openingId, ids, actor?.id);
  for (const sid of ids) {
    pushStudentNotification(tenant, sid, { type: 'job_opening', message: `New job opening: ${o.title} @ ${o.company_name}`, link: '/student/jobs', metadata: { opening_id: openingId } });
  }
  return { matched: ids.length, fired };
};

// ---------- Applications ----------
// Attach a signed CV URL (from the student's stored cv_r2_key) so the placement
// team can open/forward each candidate's resume.
const signCv = async (row) => ({ ...row, cv_url: row.cv_r2_key ? await getDownloadSignedUrl({ key: row.cv_r2_key, expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS }).catch(() => null) : null });
export const listApplications = async (tenant, actor, openingId) =>
  Promise.all((await repo.listApplications(tenant, openingId)).map(signCv));
export const setApplicationStatus = async (tenant, actor, applicationId, status, note, offerCtc) => {
  const a = await repo.applicationById(tenant, applicationId);
  if (!a) throw notFound('Application not found');
  return repo.setApplicationStatus(tenant, applicationId, status, note, offerCtc);
};

// ---------- Dynamic stages (tenant-defined pipeline) ----------
export const listStages = async (tenant, actor, branchId) => {
  const scope = await resolveScope(tenant, actor, branchId);
  return repo.listStages(tenant, scope);
};
export const createStage = async (tenant, actor, input) => {
  if (!input.name || !String(input.name).trim()) throw validationError({ name: 'Stage name is required' });
  const kind = ['in_progress', 'success', 'rejected'].includes(input.kind) ? input.kind : 'in_progress';
  const branch_id = await resolveWriteBranch(tenant, actor, input.branch_id);
  return repo.createStage(tenant, { name: input.name.trim(), kind, order_index: input.order_index, branch_id }, actor?.id);
};
export const updateStage = async (tenant, actor, id, input) => {
  if (input.kind && !['in_progress', 'success', 'rejected'].includes(input.kind)) throw validationError({ kind: 'Invalid stage kind' });
  const row = await repo.updateStage(tenant, id, input);
  if (!row) throw notFound('Stage not found');
  return row;
};
export const deleteStage = async (tenant, actor, id) => { await repo.deleteStage(tenant, id); return { ok: true }; };

// Move a candidate to a stage. A 'rejected'-kind stage REQUIRES a reason
// (candidate dropped / client dropped / rejected). Every move is recorded with
// a timestamp in the application's history.
export const moveStage = async (tenant, actor, applicationId, stageId, reason) => {
  const a = await repo.applicationById(tenant, applicationId);
  if (!a) throw notFound('Application not found');
  const stage = await repo.stageById(tenant, stageId);
  if (!stage) throw notFound('Stage not found');
  if (stage.kind === 'rejected' && !(reason && String(reason).trim())) {
    throw validationError({ reason: 'A reason is required when rejecting or dropping a candidate.' });
  }
  return repo.moveApplicationStage(tenant, applicationId, stage, reason?.trim?.() ?? reason ?? null, actor?.id);
};

export const applicationHistory = async (tenant, actor, applicationId) => {
  const a = await repo.applicationById(tenant, applicationId);
  if (!a) throw notFound('Application not found');
  return repo.applicationHistory(tenant, applicationId);
};

// ---------- Student 360 (placement drill-down) ----------
// The candidate's full LMS record: profile + CV, weighted leaderboard subscores,
// per-test marks, project marks, capstone, and interview per-category scores.
export const studentReport = async (tenant, actor, studentId) => {
  const ctx = await learningRepo.getStudentContext(tenant, studentId);
  if (!ctx) throw notFound('Student not found');
  const programId = ctx.program_id;
  const [tests, projects, capstones, interviews, board] = await Promise.all([
    assessmentsRepo.studentTests(tenant, studentId),
    assessmentsRepo.studentProjects(tenant, studentId),
    programId ? capstoneRepo.studentCapstones(tenant, studentId, programId) : Promise.resolve([]),
    interviewsRepo.studentSlots(tenant, studentId),
    programId ? assessmentsRepo.leaderboard(tenant, programId) : Promise.resolve([]),
  ]);
  // Per-category interview scores per slot.
  const interviewsWithScores = await Promise.all(interviews.map(async (s) => ({
    ...s, scores: await interviewsRepo.slotScores(tenant, s.id),
  })));
  const myRow = board.find((r) => String(r.student_id) === String(studentId)) || null;
  const cvUrl = ctx.cv_r2_key ? await getDownloadSignedUrl({ key: ctx.cv_r2_key, expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS }).catch(() => null) : null;
  return {
    student: { id: ctx.id, name: ctx.name, email: ctx.email, program_name: ctx.program_name, bio: ctx.bio, cv_url: cvUrl },
    scorecard: myRow ? {
      total: Number(myRow.total), attendance_pct: Number(myRow.attendance_pct),
      test_score: Number(myRow.test_score), project_score: Number(myRow.project_score),
      capstone_score: myRow.capstone_score != null ? Number(myRow.capstone_score) : null,
      interview_score: Number(myRow.interview_score),
    } : null,
    tests, projects, capstones, interviews: interviewsWithScores,
  };
};

// ---------- Student ----------
export const studentFeed = async (tenant, studentId) => {
  const branchId = await repo.studentBranchId(tenant, studentId);
  const [openings, posters] = await Promise.all([
    Promise.all((await repo.studentOpenings(tenant, studentId)).map(signPoster)),
    Promise.all((await repo.posterFeed(tenant, branchId)).map(signPoster)),
  ]);
  return { openings, posters };
};
export const applyToOpening = async (tenant, studentId, openingId) => {
  const o = await repo.getOpening(tenant, openingId);
  if (!o) throw notFound('Opening not found');
  if (o.status !== 'open') throw validationError({ opening: 'This opening is closed.' });
  return repo.applyToOpening(tenant, openingId, studentId);
};
