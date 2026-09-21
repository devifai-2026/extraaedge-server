export const PLATFORM_ROLES = Object.freeze({
  PRODUCT_OWNER: 'product_owner',
  SUPPORT_ADMIN: 'support_admin',
});

export const SYSTEM_TENANT_ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  // Runs a single branch. Admin-like access (every other manager role plus
  // counsellors/account_managers report up to them), but WITHOUT two
  // admin-only capabilities: the full lead CSV export and sudo-login
  // (impersonation). Lead/ticket/analytics visibility is their downstream
  // team subtree only (their branch) — see TEAM_SCOPED_MANAGER_ROLES.
  BRANCH_MANAGER: 'branch_manager',
  SALES_MANAGER: 'sales_manager',
  COUNSELLOR: 'counsellor',
  // The front line splits three ways under a sales_manager: counsellors,
  // telecaller leads, and telecallers.
  //
  // TELECALLER_LEAD runs a team of telecallers. It scopes like a
  // sales_manager (own downstream subtree — see TEAM_SCOPED_MANAGER_ROLES)
  // and, like every manager tier, does NOT carry leads itself.
  TELECALLER_LEAD: 'telecaller_lead',
  // TELECALLER works assigned leads exactly as a counsellor does, and is a
  // valid leads.assigned_to owner — see LEAD_OWNER_ROLES. Reports to a
  // telecaller_lead (or straight to the sales_manager).
  TELECALLER: 'telecaller',
  // Tenant-level role for staff who handle CONVERTED leads (post-enrollment
  // account management). No team beneath them; they report to their branch
  // manager (or directly to the tenant's super_admin). Scoped lead
  // visibility: they only see leads where converted_at IS NOT NULL.
  ACCOUNT_MANAGER: 'account_manager',
  // Call-quality reviewer. Listens to matched call recordings across the
  // tenant and scores the counsellor who made the call against the
  // qa_review_parameters rubric. Read-only on leads — the only thing they
  // write is a review.
  QA: 'qa',
});

// Manager-tier roles whose lead/ticket/analytics visibility is their own
// downstream team subtree (recursive users.manager_id). branch_manager sits
// one tier above sales_manager but scopes the exact same way, so anywhere the
// code special-cases sales_manager for "see your team subtree", both apply.
export const TEAM_SCOPED_MANAGER_ROLES = Object.freeze([
  SYSTEM_TENANT_ROLES.SALES_MANAGER,
  SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  // telecaller_lead sits one tier BELOW sales_manager but scopes identically:
  // their own downstream subtree (their telecallers).
  SYSTEM_TENANT_ROLES.TELECALLER_LEAD,
]);

// Roles a lead may actually be assigned to. `leads.assigned_to` must always
// point at an ACTIVE user holding one of these. Enforced by
// assertLeadOwnerTarget() in modules/leads/repo.js (the shared insert/update
// sink) plus the assignment engine, the bulk-import resolver and the
// integration pools.
//
// Historically this was the single literal 'counsellor'; telecallers work
// leads the same way, so both buckets became owners.
//
// telecaller_lead is a DELIBERATE hybrid: it runs a team (it is also in
// TEAM_SCOPED_MANAGER_ROLES) *and* carries a personal queue, because a
// telecalling team lead works leads alongside the telecallers they manage.
// It is the only role in both sets. Code that branches "owner vs manager"
// must therefore test TEAM_SCOPED_MANAGER_ROLES **first** wherever the two
// behaviours differ (lead distribution / fan-out), so a telecaller_lead keeps
// managing instead of silently self-assigning — see assignByCreator() in
// modules/leads/service.js, resolveAssignee() in
// modules/bulk-ingestion/assignee-resolver.js and modules/quick-add/routes.js.
// Any OTHER role added here must be a front-line role with no team beneath it.
export const LEAD_OWNER_ROLES = Object.freeze([
  SYSTEM_TENANT_ROLES.COUNSELLOR,
  SYSTEM_TENANT_ROLES.TELECALLER,
  SYSTEM_TENANT_ROLES.TELECALLER_LEAD,
]);

// Roles that get admin-like route access alongside super_admin. Used to
// expand existing requireRole(SUPER_ADMIN, SALES_MANAGER) "manager-tier"
// gates so branch managers can operate their branch. The two carve-outs
// (lead CSV export, sudo-login) are NOT expanded — they stay super_admin-only.
export const ADMIN_TIER_ROLES = Object.freeze([
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
  SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
]);

// Convenience spread for the very common "admin + every manager tier" gate.
// telecaller_lead is included: it runs a team exactly as a sales_manager does,
// and every route behind this gate scopes its rows through the scope helpers
// (TEAM_SCOPED_MANAGER_ROLES), so a telecaller_lead reaching one of these
// endpoints still only sees their own subtree.
export const MANAGER_TIER_ROLES = Object.freeze([
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
  SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  SYSTEM_TENANT_ROLES.SALES_MANAGER,
  SYSTEM_TENANT_ROLES.TELECALLER_LEAD,
]);

// Which role is expected to SUPERVISE which front-line role. Drives the org
// structure warnings on /users/org-tree — a tenant running telecallers with no
// telecaller_lead above them has a real hole, not a cosmetic one: the
// stale-lead rule hands a lead to another member of the SAME role class, so a
// front line with no lead and no peers is what leaves leads stuck with an
// inactive owner.
//
// Declared as data so the check generalises: add a pair here and the warning,
// the count and the copy all follow. Nothing about telecalling is special-cased
// in the detector itself.
export const EXPECTED_SUPERVISOR = Object.freeze([
  // The three MoM roles. Safe to declare because they have ZERO users on day
  // one — assertSupervisorExists is a hard write block, so adding a pair for an
  // existing role would 400 every future edit of those users.
  {
    role: 'hr_team_lead',
    supervisor: 'branch_manager',
    label: 'HR team lead',
    supervisorLabel: 'branch manager',
  },
  {
    role: 'hr_recruiter',
    supervisor: 'hr_team_lead',
    label: 'HR recruiter',
    supervisorLabel: 'HR team lead',
  },
  {
    role: 'placement_officer',
    supervisor: 'hr_team_lead',
    label: 'placement officer',
    supervisorLabel: 'HR team lead',
  },
  {
    role: SYSTEM_TENANT_ROLES.TELECALLER,
    supervisor: SYSTEM_TENANT_ROLES.TELECALLER_LEAD,
    label: 'telecaller',
    supervisorLabel: 'telecaller lead',
  },
  {
    role: SYSTEM_TENANT_ROLES.COUNSELLOR,
    supervisor: SYSTEM_TENANT_ROLES.SALES_MANAGER,
    label: 'counsellor',
    supervisorLabel: 'sales manager',
  },
]);

export const TENANT_STATUS = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CANCELLED: 'cancelled',
  PROVISIONING: 'provisioning',
});


// Discount workflow on the Qualified stage. A counsellor may self-apply a
// discount up to COUNSELLOR_MAX_PERCENT with no approval; anything above that
// requires a manager (sales_manager / branch_manager / super_admin) to
// approve. The discount % is surfaced to the Accounts team on the lead.
export const DISCOUNT = Object.freeze({
  COUNSELLOR_MAX_PERCENT: 10,
  MAX_PERCENT: 100,
  STATUS: Object.freeze({
    APPROVED: 'approved',
    PENDING: 'pending_approval',
    REJECTED: 'rejected',
  }),
});

export const CALL_DISPOSITIONS = Object.freeze({
  CONNECTED: { code: 'Connected', label: 'Connected', category: 'positive', requires_callback: false },
  RNR: { code: 'RNR', label: 'Ringing – No Answer', category: 'neutral', requires_callback: true, auto_followup_hours: 4 },
  BUSY: { code: 'Busy', label: 'Line Busy', category: 'neutral', requires_callback: true, auto_followup_hours: 2 },
  WRONG_NUMBER: { code: 'Wrong_Number', label: 'Wrong Number', category: 'negative', requires_callback: false },
  LANGUAGE_BARRIER: { code: 'Language_Barrier', label: 'Language Barrier', category: 'neutral', requires_callback: false },
  NOT_INTERESTED: { code: 'Not_Interested', label: 'Not Interested', category: 'negative', requires_callback: false },
  CALLBACK_REQUESTED: { code: 'Callback_Requested', label: 'Callback Requested', category: 'positive', requires_callback: true, auto_followup_hours: 24 },
  DEMO_SCHEDULED: { code: 'Demo_Scheduled', label: 'Demo Scheduled', category: 'positive', requires_callback: false },
  ENROLLED: { code: 'Enrolled', label: 'Enrolled', category: 'positive', requires_callback: false },
});

export const SENSITIVE_HEADER_KEYS = Object.freeze([
  'authorization',
  'cookie',
  'x-api-key',
  'x-tenant-slug',
]);

export const RESPONSE_CODES = Object.freeze({
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  CONCURRENT_MODIFICATION: 'CONCURRENT_MODIFICATION',
  RATE_LIMITED: 'RATE_LIMITED',
  DUPLICATE_DETECTED: 'DUPLICATE_DETECTED',
  FIELD_READONLY: 'FIELD_READONLY',
  SESSION_IDLE: 'SESSION_IDLE',
  CLOCK_IN_REQUIRED: 'CLOCK_IN_REQUIRED',
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',
  INTERNAL: 'INTERNAL',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  NO_OPTIN: 'NO_OPTIN',
  SUPPRESSED: 'SUPPRESSED',
});

export const EVENT_TYPES = Object.freeze({
  LEAD_CREATED: 'lead.created',
  LEAD_UPDATED: 'lead.updated',
  LEAD_STAGE_CHANGED: 'lead.stage_changed',
  LEAD_ASSIGNED: 'lead.assigned',
  LEAD_MERGED: 'lead.merged',
  FOLLOWUP_SCHEDULED: 'follow_up.scheduled',
  FOLLOWUP_DUE: 'follow_up.due',
  FOLLOWUP_COMPLETED: 'follow_up.completed',
  FOLLOWUP_MISSED: 'follow_up.missed',
  MESSAGE_QUEUED: 'message.queued',
  MESSAGE_SENT: 'message.sent',
  MESSAGE_DELIVERED: 'message.delivered',
  MESSAGE_FAILED: 'message.failed',
  MESSAGE_REPLIED: 'message.replied',
  CALL_COMPLETED: 'call.completed',
  PAYMENT_CREATED: 'payment.created',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  CAMPAIGN_LAUNCHED: 'campaign.launched',
  CAMPAIGN_COMPLETED: 'campaign.completed',
  WORKFLOW_STARTED: 'workflow.started',
  WORKFLOW_COMPLETED: 'workflow.completed',
  BULK_IMPORT_COMPLETED: 'bulk_import.completed',
});

export const QUEUE_NAMES = Object.freeze({
  EVENTS: 'events',
  EMAIL: 'email-send',
  SMS: 'sms-send',
  // WHATSAPP queue removed — automated WhatsApp is disabled; per-user manual
  // chat runs in the whatsapp-web.js gateway, not via a job queue.
  BULK_IMPORT: 'bulk-import',
  // Historical-admission import. Deliberately its OWN queue rather than a
  // second job name on BULK_IMPORT: in-process mode (QUEUE_DRIVER != bullmq)
  // registers handlers with jobName '*', so a second registerWorker on the
  // same queue would hand every lead job to the admissions worker too.
  BULK_ADMISSION_IMPORT: 'bulk-admission-import',
  // Speedup Hiring candidate/interview sheet import. Its own queue, not a
  // second job name on BULK_IMPORT: in in-process mode registerWorker binds
  // jobName '*', so sharing a queue hands every lead-import job here too.
  HIRING_IMPORT: 'hiring-import',
  BULK_EXPORT: 'bulk-export',
  CAMPAIGN: 'campaign-run',
  DRIP: 'drip-step',
  SCHEDULED_SEND: 'scheduled-send',
  WORKFLOW: 'workflow-step',
  NOTIFICATIONS: 'notifications',
  OUTBOUND_WEBHOOK: 'outbound-webhook',
  PDF: 'pdf-report',
});

export const DEFAULT_BUSINESS_HOURS = Object.freeze([
  { day_of_week: 0, is_open: false, open_time: null, close_time: null }, // Sunday
  { day_of_week: 1, is_open: true, open_time: '10:00', close_time: '19:00' },
  { day_of_week: 2, is_open: true, open_time: '10:00', close_time: '19:00' },
  { day_of_week: 3, is_open: true, open_time: '10:00', close_time: '19:00' },
  { day_of_week: 4, is_open: true, open_time: '10:00', close_time: '19:00' },
  { day_of_week: 5, is_open: true, open_time: '10:00', close_time: '19:00' },
  { day_of_week: 6, is_open: true, open_time: '10:00', close_time: '19:00' },
]);

export const DEFAULT_TAB_KEYS = Object.freeze([
  'dashboard',
  'leads',
  'raw_data',
  'failed_leads',
  'bulk_upload',
  'followups',
  'whatsapp',
  'bulk_marketing',
  'drip_marketing',
  'remarketing',
  'automation',
  'connected_accounts',
  'settings.email_templates',
  'settings.sms_templates',
  'settings.whatsapp_templates',
  'settings.lead_score',
  'settings.assignment_rules',
  'advanced.dropdowns',
  'advanced.users_roles',
  'advanced.communications',
  'advanced.subscription',
  'third_party_integration',
  'reports',
  'analytics',
  // Lead Transfer / Lead Report — admin + sales_manager. Telecaller /
  // Counsellor performance via the immutable lead_assignments ledger.
  'lead_transfer_report',
  // Reassign Logs — super_admin ONLY. Actor-first audit of manual lead moves
  // (who moved what, to whom, in bulk or one-off). Separate key from
  // lead_transfer_report because managers legitimately read that report, but
  // this one exists to audit the managers/admins themselves.
  'reassign_logs',
  // Stale Leads — the 6-day/7-day auto-handover rule made visible: what was
  // flagged, what moved to whom, and what was held because nobody else in the
  // same role class was free. Admin + manager tiers.
  'stale_handovers',
  // Missed Leads — every lead whose follow-up was promised and not kept.
  // Leads carrying a follow-up are exempt from the stale-lead rotation
  // (including missed ones: a broken promise means the OWNER needs chasing,
  // not that the lead should be taken off them), so this tab is the
  // counterweight that keeps them visible. Front line AND manager tiers: the
  // route scopes a lead owner to their own rows and a manager to their team's.
  'missed_leads',
  // Duplicate lead finder + merge. super_admin and branch_manager: merging is
  // destructive to one record, and a branch manager is the person who knows
  // whether two rows are the same human.
  'duplicates',
  // Unmatched call recordings uploaded from the mobile app whose number
  // matched no lead — counsellors review their own, managers see scope, and
  // can create a lead from the number.
  'unmatched_recordings',
  // Tenant-wide read-only Lead Pool. Every counsellor (and up) can look up
  // ANY lead in the tenant by name or phone — bypassing the normal
  // owner/team/branch visibility scope — but the view is strictly read-only:
  // lead details plus current owner, manager, and previous owner. Lets a
  // counsellor answer "who owns this number?" without a reassign.
  'lead_pool',
  // Accounts module (account_manager role). These show up in the
  // super_admin's "tab permissions" matrix so the role assignments can
  // be tuned per tenant without a code deploy.
  'accounts.dashboard',
  'accounts.pending_admissions',
  'accounts.this_month_admissions',
  'accounts.total_admissions',
  'accounts.approvals',
  'accounts.attendings',
  'accounts.break',
  'accounts.drop_candidates',
  'accounts.report',
  'accounts.pay_schedule',
  'accounts.collection_receipt_wise',
  // Admin Payment Details ledger. NOTE: this key was missing here for a long
  // time even though the Sidebar item + route both gate on it — meaning only
  // wildcard-tab roles (super_admin, branch_manager) could ever see the page.
  // Added + backfilled (migration 1700000124000) to account_manager and
  // sales_manager too, who should obviously have their own ledger.
  'accounts.payment_details',
  // Accounts-side importer for historical admissions migrated off a previous
  // CRM. One spreadsheet row fans out into lead + fee offer + admission +
  // EMI schedule + old-collection receipts, so it's gated separately from
  // the counsellor lead upload (which only ever creates leads).
  'accounts.bulk_import',
  // Tenant-wide admission pipeline view for admins. Lives in the main
  // sidebar (not the Accounts module) so super_admins can see every
  // converted lead's admission status without leaving their normal
  // surfaces. Defaulted to super_admin only at provisioning time.
  'admissions.pipeline',
  // ---- QA call reviews ---------------------------------------------------
  // qa.reviews is the reviewer's scoring queue (qa + super_admin only — the
  // routes behind it reject manager tiers). qa.feedback is the read-back
  // report for admins / branch managers / sales managers.
  'qa.reviews',
  'qa.feedback',
  // Counsellor-facing admissions tab: shows ONLY the students they converted
  // (scoped server-side by guided_by_counsellor_id). They configure the fee
  // offer + send the admission link from here. Seeded to counsellor.
  'admissions.my_students',
  // ---- LMS / Trainer module ----------------------------------------------
  // Course management (modules, syllabus, trainer roster, batches). Seeded to
  // head_trainer (+ super_admin). Trainers read their own course from here.
  'courses.manage',
  // Trainer working surfaces (seeded to trainer + head_trainer). Each maps to
  // a page in the trainer nav group; scoped server-side to the trainer's own
  // courses via course_trainers membership.
  'trainer.classes',
  'trainer.attendance',
  'trainer.recordings',
  'trainer.announcements',
  'trainer.forum',
  'trainer.tests',
  'trainer.projects',
  'trainer.interviews',
  'trainer.leaderboard',
  'trainer.materials',
  // Student panel surfaces (seeded to the student role). Rendered in the
  // separate /student/* layout, gated to the student principal.
  'student.home',
  'student.classes',
  'student.forum',
  'student.tests',
  'student.projects',
  'student.leaderboard',
  'student.catalog',
  'student.materials',
  'student.certificate',
  'student.jobs',
  // LMS analytics dashboards — super_admin + branch_manager (branch-scoped).
  'lms.analytics',
  // HR department (operations: interview scoring, certificates).
  'hr.dashboard',
  'hr.interviews',
  'hr.certificates',
  // Speedup Hiring — internal staff recruitment. hr_recruiter + hr_team_lead
  // only: candidate rows carry salary expectations and personal contact
  // details for people who do not work here.
  'hiring.dashboard',
  'hiring.positions',
  'hiring.candidates',
  'hiring.interviews',
  'hiring.statuses',
  'hiring.imports',
  // Placement department (companies, job openings, applications).
  'placement.dashboard',
  'placement.companies',
  'placement.openings',
  'placement.applications',
]);

// LMS tenant roles (teaching staff + the authenticated learner). Kept separate
// from SYSTEM_TENANT_ROLES so the CRM role gates (lead/admission scopes) don't
// accidentally include them; these are seeded as their own custom_roles
// bundles at provisioning + via a seed migration for existing tenants.
export const LMS_TENANT_ROLES = Object.freeze({
  HEAD_TRAINER: 'head_trainer',
  TRAINER: 'trainer',
  STUDENT: 'student',
  HR: 'hr',
  PLACEMENT: 'placement',
  // The MoM's HR/Placement tiers. Declared HERE and not in SYSTEM_TENANT_ROLES
  // on purpose: that object is spread into LEAD_OWNER_ROLES,
  // TEAM_SCOPED_MANAGER_ROLES, MANAGER_TIER_ROLES and ADMIN_TIER_ROLES, so
  // adding them there would silently hand them lead scope and manager gates.
  // Living here, they fall through computeScope to { user_ids: [actor.id] } —
  // they see nothing they were not explicitly granted.
  //
  // "Trainer Team Lead" in the MoM maps to the EXISTING head_trainer; a second
  // role for the same job would split the course roster in two.
  HR_TEAM_LEAD: 'hr_team_lead',
  HR_RECRUITER: 'hr_recruiter',
  PLACEMENT_OFFICER: 'placement_officer',
});

// Who may create, edit and offboard STAFF accounts.
//
// ADMIN_TIER_ROLES (super_admin + branch_manager) plus hr_team_lead, because
// onboarding people is the HR lead's actual job and the MoM asks for it. HR is
// still blocked from admin-tier accounts by assertHrScope — this constant only
// says "may reach the user-management endpoints at all".
//
// hr_recruiter IS here: "staff onboarded" is part of the role's brief, and a
// recruiter who cannot create the account for someone they just hired has to
// hand the last step to someone else. They remain blocked from admin-tier
// accounts by assertHrScope — this constant only says "may reach the
// user-management endpoints at all", not "may create a super_admin".
export const STAFF_ADMIN_ROLES = Object.freeze([
  ...ADMIN_TIER_ROLES,
  LMS_TENANT_ROLES.HR_TEAM_LEAD,
  LMS_TENANT_ROLES.HR_RECRUITER,
]);


// Tab bundles per LMS role — used by provisioning + the seed migration so the
// grant list stays in one place.
export const TRAINER_TAB_KEYS = Object.freeze([
  'trainer.classes', 'trainer.attendance', 'trainer.recordings',
  'trainer.announcements', 'trainer.forum', 'trainer.tests',
  'trainer.projects', 'trainer.interviews', 'trainer.leaderboard',
  'trainer.materials',
]);
export const HEAD_TRAINER_TAB_KEYS = Object.freeze([
  'courses.manage', ...TRAINER_TAB_KEYS,
]);
export const STUDENT_TAB_KEYS = Object.freeze([
  'student.home', 'student.classes', 'student.forum', 'student.tests',
  'student.projects', 'student.leaderboard', 'student.catalog',
  'student.materials', 'student.certificate', 'student.jobs',
]);
export const HR_TAB_KEYS = Object.freeze([
  'hr.dashboard', 'hr.interviews', 'hr.certificates',
]);
export const PLACEMENT_TAB_KEYS = Object.freeze([
  'placement.dashboard', 'placement.companies', 'placement.openings', 'placement.applications',
]);
// QA: the review queue is the reviewer's working surface; the feedback report
// is the manager read-back, so the two are granted separately.
// Branch manager tabs — EXPLICIT, deliberately NOT the '*' wildcard.
//
// The wildcard used to be handed out here "so the sidebar isn't starved", and
// it silently granted every money surface in the product: the Accounts module
// (collection totals, overdue installments with per-student rupee amounts, the
// pay schedule, the receipt-wise collection report, the payment-details
// ledger), the standalone Payments Ledger, payroll runs and salary structures,
// and the revenue tiles/charts on the analytics dashboard.
//
// The rule from the business is narrow: a branch manager approves registration
// amounts and nothing more. Real money belongs to super_admin and the accounts
// team. So the role gets an explicit list, and anything new added to
// DEFAULT_TAB_KEYS later is withheld until someone decides it belongs here —
// the opposite of the wildcard's fail-open behaviour, and the whole point of
// listing it out.
//
// Their remaining lead/CRM oversight is unchanged; only money is withdrawn.
export const BRANCH_MANAGER_TAB_KEYS = Object.freeze([
  // Lead + CRM oversight (their actual job).
  'dashboard',
  'leads',
  'lead_pool',
  'raw_data',
  'failed_leads',
  'bulk_upload',
  'followups',
  'whatsapp',
  'bulk_marketing',
  'drip_marketing',
  'remarketing',
  'automation',
  'connected_accounts',
  'third_party_integration',
  'settings.email_templates',
  'settings.sms_templates',
  'settings.whatsapp_templates',
  'settings.lead_score',
  'settings.assignment_rules',
  'advanced.dropdowns',
  'advanced.users_roles',
  'advanced.communications',
  // Reporting on people and leads — no rupee figures on these surfaces.
  'reports',
  'analytics',
  'lead_transfer_report',
  'stale_handovers',
  'missed_leads',
  'unmatched_recordings',
  'qa.feedback',
  'lms.analytics',
  // Duplicate finder + merge — cleaning up the lead list is branch work.
  'duplicates',
  // HR/placement oversight. Deliberately excludes payroll.* — salary is money.
  'hr.dashboard',
  'hr.interviews',
  'hr.certificates',
  'hr.my_leave',
  'hr.leave_calendar',
  'hr.leave_approvals',
  'placement.dashboard',
  'placement.companies',
  'placement.openings',
  'placement.applications',
  // The admission approvals queue, and with it the admission DETAIL page
  // (/accounts/admission/:id) which is the only place a registration receipt
  // can be viewed, downloaded or share-linked. Withholding this left the role
  // with a registration balance to collect and no way to reach the receipt
  // proving it was — the approval they own, with its evidence locked away.
  // The fee columns on the list and the money tiles on the detail page are
  // already withheld per-field (stripAdmissionMoney + the showFees gate), so
  // granting the route exposes no course money.
  'accounts.approvals',
  // DELIBERATELY ABSENT — 'admissions.pipeline' (the branch manager has no
  // use for a post-conversion pipeline; that is the accounts team's surface),
  // the remaining accounts.* keys, 'payments',
  // and the whole payroll group ('payroll.runs',
  // 'payroll.structures', 'payroll.my_payslips'). These are the money
  // surfaces. Registration-amount approval happens on the discount/fee-offer
  // approval flow, not from the Accounts module.
  //
  // payroll.my_payslips is only the role's OWN salary, which most staff roles
  // do get — it is withheld here because the ask was to take payroll off a
  // branch manager's sidebar entirely. Their payslip reaches them by whatever
  // route HR already uses off-platform.
]);

export const QA_TAB_KEYS = Object.freeze(['qa.reviews', 'qa.feedback']);

// HR Team Lead owns HR *and* placement per the MoM ("full access to HR
// recruiters + placement officers"), so its bundle is the union plus the LMS
// analytics it needs for student/drop reports.
// Speedup Hiring surfaces. Declared before the role bundles that spread it —
// a const used above its declaration throws on module load (temporal dead
// zone), which takes the whole server down rather than failing gracefully.
export const HIRING_TAB_KEYS = Object.freeze([
  'hiring.dashboard', 'hiring.positions', 'hiring.candidates',
  'hiring.interviews', 'hiring.statuses', 'hiring.imports',
]);
export const HR_TEAM_LEAD_TAB_KEYS = Object.freeze([
  ...HR_TAB_KEYS, ...PLACEMENT_TAB_KEYS, ...HIRING_TAB_KEYS, 'lms.analytics',
]);
// Recruiter owns recruitment AND staffing: hiring pipeline, onboarding the
// people they hire, then the leave and payroll admin for that workforce.
// No placement (that is the placement officer's) and no LMS analytics.
export const HR_RECRUITER_TAB_KEYS = Object.freeze([
  ...HR_TAB_KEYS,
  ...HIRING_TAB_KEYS,
  // Leave administration — approve/decline requests plus quotas and holidays.
  'hr.leave_approvals', 'hr.leave_admin',
  // Payroll administration. NOTE this exposes every employee's salary; it is
  // granted because payroll management is explicitly part of this role.
  // Releasing money is still separate — see DISBURSE_ROLES in payroll/service.
  'payroll.runs', 'payroll.structures',
]);
// Placement officer runs companies/openings/applications and is the one who
// assigns mock interviews, hence hr.interviews on top of the placement set.
export const PLACEMENT_OFFICER_TAB_KEYS = Object.freeze([
  ...PLACEMENT_TAB_KEYS, 'hr.interviews',
]);
