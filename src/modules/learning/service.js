// LMS learning layer — business logic. Trainer/admin actions are scoped to the
// actor's own courses (course_trainers membership); student actions are scoped
// to the student's own program. Certificate eligibility ties together module
// progress + attendance so "finish the course" has a concrete meaning.
import * as repo from './repo.js';
import * as coursesRepo from '../courses/repo.js';
import * as assessmentsRepo from '../assessments/repo.js';
import { notFound, forbidden, validationError } from '../../lib/errors.js';
import { getDownloadSignedUrl } from '../../lib/r2.js';
import { env } from '../../config/env.js';
import { SYSTEM_TENANT_ROLES, LMS_TENANT_ROLES } from '../../config/constants.js';
import { notifyBatch, pushStudentNotification } from '../student-notifications/service.js';

const MIN_ATTENDANCE_PCT = 50; // certificate threshold — enforced by auto-issue (all modules complete AND attendance ≥ this)

const isAdmin = (actor) => actor?.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN || actor?.role === SYSTEM_TENANT_ROLES.BRANCH_MANAGER;
const isHrOrAdmin = (actor) => isAdmin(actor) || actor?.role === LMS_TENANT_ROLES.HR;
const assertProgramTrainer = async (tenant, programId, actor) => {
  if (isAdmin(actor)) return;
  const m = await coursesRepo.isCourseTrainer(tenant, programId, actor?.id);
  if (!m) throw forbidden('You are not assigned to this course.');
};

const signIfFile = async (mat) => {
  if (mat.kind === 'link') return { url: mat.url };
  if (!mat.r2_key) throw notFound('File is missing.');
  const url = await getDownloadSignedUrl({ key: mat.r2_key, expiresIn: env.GCS_SIGNED_URL_TTL_SECONDS, downloadAs: mat.file_name || undefined });
  return { url };
};

// ---------- Materials (trainer/admin) ----------
export const listMaterials = async (tenant, actor, programId) => {
  await assertProgramTrainer(tenant, programId, actor);
  return repo.listMaterials(tenant, programId);
};

export const createMaterial = async (tenant, actor, input) => {
  await assertProgramTrainer(tenant, input.program_id, actor);
  if (input.kind === 'link' && !input.url) throw validationError({ url: 'A link URL is required.' });
  if (input.kind === 'file' && !input.r2_key) throw validationError({ r2_key: 'Upload the file first.' });
  const row = await repo.createMaterial(tenant, input, actor?.id);
  notifyBatch(tenant, { programId: input.program_id }, {
    type: 'material_added', message: `New study material: ${input.title}`, link: '/student/materials', metadata: { material_id: row?.id },
  });
  return row;
};

export const deleteMaterial = async (tenant, actor, id) => {
  const mat = await repo.getMaterial(tenant, id);
  if (!mat) throw notFound('Material not found.');
  await assertProgramTrainer(tenant, mat.program_id, actor);
  await repo.softDeleteMaterial(tenant, id);
  return { ok: true };
};

export const trainerMaterialUrl = async (tenant, actor, id) => {
  const mat = await repo.getMaterial(tenant, id);
  if (!mat) throw notFound('Material not found.');
  await assertProgramTrainer(tenant, mat.program_id, actor);
  return signIfFile(mat);
};

// ---------- Materials (student) ----------
export const studentMaterials = async (tenant, studentId) => {
  const programId = await assessmentsRepo.studentProgram(tenant, studentId);
  if (!programId) return { materials: [], modules: [] };
  const [materials, modules] = await Promise.all([
    repo.listMaterials(tenant, programId),
    coursesRepo.listModules(tenant, programId),
  ]);
  return { materials, modules: modules.map((m) => ({ id: m.id, name: m.name })) };
};

export const studentMaterialUrl = async (tenant, studentId, materialId) => {
  const programId = await assessmentsRepo.studentProgram(tenant, studentId);
  const mat = await repo.getMaterial(tenant, materialId);
  if (!mat || mat.program_id !== programId) throw notFound('Material not found.');
  return signIfFile(mat);
};

// ---------- Progress ----------
export const studentProgress = async (tenant, studentId) => {
  const programId = await assessmentsRepo.studentProgram(tenant, studentId);
  if (!programId) return { modules: [], pct: 0, completed: 0, total: 0 };
  const [modules, completedIds] = await Promise.all([
    coursesRepo.listModules(tenant, programId),
    repo.completedModuleIds(tenant, studentId, programId),
  ]);
  const done = new Set(completedIds.map(String));
  const list = modules.map((m) => ({ id: m.id, name: m.name, order_index: m.order_index, completed: done.has(String(m.id)) }));
  const completed = list.filter((m) => m.completed).length;
  return { modules: list, completed, total: list.length, pct: list.length ? Math.round((completed / list.length) * 100) : 0 };
};

export const trainerProgress = async (tenant, actor, programId) => {
  await assertProgramTrainer(tenant, programId, actor);
  return repo.progressByModule(tenant, programId);
};

// Trainer/head certifies module completion for students (per-student list; the
// FE can pass all students in a batch for a "mark whole batch" action).
export const moduleCompletion = async (tenant, actor, programId, moduleId) => {
  await assertProgramTrainer(tenant, programId, actor);
  return repo.studentsWithModuleCompletion(tenant, programId, moduleId);
};

export const markModuleCompletion = async (tenant, actor, { program_id, module_id, student_ids, completed }) => {
  await assertProgramTrainer(tenant, program_id, actor);
  const modules = await coursesRepo.listModules(tenant, program_id);
  if (!modules.some((m) => String(m.id) === String(module_id))) throw notFound('Module is not in this course.');
  for (const sid of student_ids) {
    // eslint-disable-next-line no-await-in-loop
    if (completed) await repo.markModule(tenant, sid, program_id, module_id);
    // eslint-disable-next-line no-await-in-loop
    else await repo.unmarkModule(tenant, sid, module_id);
  }
  // Auto-issue a certificate to any student who has now completed EVERY module.
  if (completed) {
    for (const sid of student_ids) {
      // eslint-disable-next-line no-await-in-loop
      await autoIssueIfComplete(tenant, program_id, sid, actor?.id).catch(() => {});
    }
  }
  return repo.studentsWithModuleCompletion(tenant, program_id, module_id);
};

// Issue a completion certificate once the student is fully ELIGIBLE — all
// modules complete AND attendance ≥ MIN_ATTENDANCE_PCT (idempotent). Previously
// this issued on module-completion alone, contradicting the attendance
// requirement the student's own certificate card advertises; now the auto-issue
// path and computeEligibility agree.
const autoIssueIfComplete = async (tenant, programId, studentId, issuedBy) => {
  const existing = await repo.getCertificate(tenant, studentId, programId);
  if (existing) return existing;
  const elig = await computeEligibility(tenant, studentId, programId);
  if (!elig.eligible) return null;
  const number = await nextCertNumber(tenant, programId);
  const created = await repo.insertCertificate(tenant, { student_id: studentId, program_id: programId, certificate_number: number, issued_by: issuedBy ?? null, meta: elig.meta });
  if (created) pushStudentNotification(tenant, studentId, { type: 'certificate_issued', message: '🎓 Your course-completion certificate is ready!', link: '/student/certificate', metadata: { certificate_number: created.certificate_number } });
  return created;
};

// ---------- Certificate eligibility ----------
const computeEligibility = async (tenant, studentId, programId) => {
  const [modules, completedIds, lb] = await Promise.all([
    coursesRepo.listModules(tenant, programId),
    repo.completedModuleIds(tenant, studentId, programId),
    assessmentsRepo.leaderboard(tenant, programId),
  ]);
  const done = new Set(completedIds.map(String));
  const modulesTotal = modules.length;
  const modulesCompleted = modules.filter((m) => done.has(String(m.id))).length;
  const progressPct = modulesTotal ? Math.round((modulesCompleted / modulesTotal) * 100) : 0;
  const myRow = lb.find((r) => String(r.student_id) === String(studentId));
  const attendancePct = myRow ? Number(myRow.attendance_pct) : 0;
  const totalScore = myRow ? Number(myRow.total) : 0;

  const requirements = [
    { key: 'modules', label: modulesTotal ? `Complete all ${modulesTotal} modules` : 'Course has no modules yet', met: modulesTotal > 0 && modulesCompleted === modulesTotal, detail: `${modulesCompleted}/${modulesTotal} done` },
    { key: 'attendance', label: `Attendance at least ${MIN_ATTENDANCE_PCT}%`, met: attendancePct >= MIN_ATTENDANCE_PCT, detail: `${attendancePct}%` },
  ];
  const eligible = requirements.every((r) => r.met);
  const meta = { attendance_pct: attendancePct, total_score: totalScore, modules_completed: modulesCompleted, modules_total: modulesTotal, progress_pct: progressPct };
  return { eligible, requirements, meta };
};

export const getCertificateView = async (tenant, studentId) => {
  const ctx = await repo.getStudentContext(tenant, studentId);
  if (!ctx) throw notFound('Student not found.');
  if (!ctx.program_id) return { student_name: ctx.name, program_name: null, eligible: false, requirements: [], meta: {}, issued: null };
  const [elig, issued] = await Promise.all([
    computeEligibility(tenant, studentId, ctx.program_id),
    repo.getCertificate(tenant, studentId, ctx.program_id),
  ]);
  return { student_name: ctx.name, program_name: ctx.program_name, eligible: elig.eligible, requirements: elig.requirements, meta: elig.meta, issued };
};

const nextCertNumber = async (tenant, programId) => {
  const seq = await repo.countCertificates(tenant, programId);
  return `CERT-${new Date().getFullYear()}-${String(seq + 1).padStart(4, '0')}`;
};

// Certificates are issued by the institute (auto on completion or by HR) — no
// student self-claim. HR/admin manage issuance below.
export const hrListCertificates = async (tenant, actor, programId) => {
  if (!isHrOrAdmin(actor)) throw forbidden('HR or admin only.');
  if (!programId) return [];
  return repo.listCertificates(tenant, programId);
};

// HR bulk-issues certificates for every student in a program who has completed
// the whole course (idempotent — already-issued students are skipped).
export const hrAutoIssueForProgram = async (tenant, actor, programId) => {
  if (!isHrOrAdmin(actor)) throw forbidden('HR or admin only.');
  const students = await repo.studentsInProgram(tenant, programId);
  let issued = 0;
  for (const s of students) {
    // eslint-disable-next-line no-await-in-loop
    const row = await autoIssueIfComplete(tenant, programId, s.id, actor?.id).catch(() => null);
    if (row) issued += 1;
  }
  return { issued, total_students: students.length };
};

// ---------- Certificate (trainer/admin) ----------
export const listCertificates = async (tenant, actor, programId) => {
  await assertProgramTrainer(tenant, programId, actor);
  return repo.listCertificates(tenant, programId);
};

export const issueCertificateFor = async (tenant, actor, programId, studentId) => {
  await assertProgramTrainer(tenant, programId, actor);
  const ctx = await repo.getStudentContext(tenant, studentId);
  if (!ctx || ctx.program_id !== programId) throw notFound('Student is not in this course.');
  const existing = await repo.getCertificate(tenant, studentId, programId);
  if (existing) return existing;
  const elig = await computeEligibility(tenant, studentId, programId);
  const number = await nextCertNumber(tenant, programId);
  const created = await repo.insertCertificate(tenant, { student_id: studentId, program_id: programId, certificate_number: number, issued_by: actor?.id, meta: elig.meta });
  return created || repo.getCertificate(tenant, studentId, programId);
};

// ---------- Gamification (dashboard) ----------
export const studentHomeExtras = async (tenant, studentId) => {
  const streak = await repo.pingActivity(tenant, studentId);
  const ctx = await repo.getStudentContext(tenant, studentId);
  const programId = ctx?.program_id;

  let progressPct = 0; let attendancePct = 0; let rank = null;
  let testScore = 0; let totalScore = 0; let certIssued = false;
  let modulesTotal = 0; let modulesCompleted = 0;

  if (programId) {
    const [modules, completedIds, lb, cert] = await Promise.all([
      coursesRepo.listModules(tenant, programId),
      repo.completedModuleIds(tenant, studentId, programId),
      assessmentsRepo.leaderboard(tenant, programId),
      repo.getCertificate(tenant, studentId, programId),
    ]);
    const done = new Set(completedIds.map(String));
    modulesTotal = modules.length;
    modulesCompleted = modules.filter((m) => done.has(String(m.id))).length;
    progressPct = modulesTotal ? Math.round((modulesCompleted / modulesTotal) * 100) : 0;
    const idx = lb.findIndex((r) => String(r.student_id) === String(studentId));
    if (idx >= 0) { rank = idx + 1; attendancePct = Number(lb[idx].attendance_pct); testScore = Number(lb[idx].test_score); totalScore = Number(lb[idx].total); }
    certIssued = !!cert;
  }

  const profilePro = !!(ctx?.photo_r2_key && ctx?.cv_r2_key && ctx?.bio);
  const badges = [
    { key: 'enrolled', label: 'Enrolled', icon: '🎓', earned: true, hint: 'Joined the course' },
    { key: 'profile_pro', label: 'Profile Pro', icon: '🪪', earned: profilePro, hint: 'Add a photo, CV and bio' },
    { key: 'first_test', label: 'First Test', icon: '📝', earned: testScore > 0, hint: 'Attempt your first test' },
    { key: 'halfway', label: 'Halfway There', icon: '🚀', earned: progressPct >= 50, hint: 'Complete half your modules' },
    { key: 'course_complete', label: 'Course Complete', icon: '✅', earned: modulesTotal > 0 && modulesCompleted === modulesTotal, hint: 'Finish every module' },
    { key: 'perfect_attendance', label: 'Perfect Attendance', icon: '🎯', earned: attendancePct >= 100, hint: 'Attend every class' },
    { key: 'podium', label: 'Podium', icon: '🏆', earned: !!rank && rank <= 3 && totalScore > 0, hint: 'Reach the top 3' },
    { key: 'on_fire', label: 'On Fire', icon: '🔥', earned: (streak.current_streak || 0) >= 7, hint: '7-day activity streak' },
    { key: 'certified', label: 'Certified', icon: '📜', earned: certIssued, hint: 'Claim your certificate' },
  ];

  return {
    streak: { current: streak.current_streak || 0, longest: streak.longest_streak || 0 },
    badges,
    progress: { pct: progressPct, completed: modulesCompleted, total: modulesTotal },
    rank,
  };
};
