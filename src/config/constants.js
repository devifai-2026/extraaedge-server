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
  // Tenant-level role for staff who handle CONVERTED leads (post-enrollment
  // account management). No team beneath them; they report to their branch
  // manager (or directly to the tenant's super_admin). Scoped lead
  // visibility: they only see leads where converted_at IS NOT NULL.
  ACCOUNT_MANAGER: 'account_manager',
});

// Manager-tier roles whose lead/ticket/analytics visibility is their own
// downstream team subtree (recursive users.manager_id). branch_manager sits
// one tier above sales_manager but scopes the exact same way, so anywhere the
// code special-cases sales_manager for "see your team subtree", both apply.
export const TEAM_SCOPED_MANAGER_ROLES = Object.freeze([
  SYSTEM_TENANT_ROLES.SALES_MANAGER,
  SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
]);

// Roles that get admin-like route access alongside super_admin. Used to
// expand existing requireRole(SUPER_ADMIN, SALES_MANAGER) "manager-tier"
// gates so branch managers can operate their branch. The two carve-outs
// (lead CSV export, sudo-login) are NOT expanded — they stay super_admin-only.
export const ADMIN_TIER_ROLES = Object.freeze([
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
  SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
]);

// Convenience spread for the very common "admin + both manager tiers" gate.
export const MANAGER_TIER_ROLES = Object.freeze([
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
  SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  SYSTEM_TENANT_ROLES.SALES_MANAGER,
]);

export const TENANT_STATUS = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CANCELLED: 'cancelled',
  PROVISIONING: 'provisioning',
});

export const LEAD_STAGE_CODES = Object.freeze({
  NEW: '01-New',
  CONTACTED: '02-Contacted',
  FOLLOWUP: '03-Followup',
  QUALIFIED: '05-Qualified',
  REQUIREMENT_MATCH: '07-Requirement-Match',
  INTERESTED: '08-Interested',
  VISITED: '09-Visited',
  ENROLLED: '10-Enrolled',
  JUNK: '11-Junk',
  COLD: '12-Cold',
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
  // Tenant-wide admission pipeline view for admins. Lives in the main
  // sidebar (not the Accounts module) so super_admins can see every
  // converted lead's admission status without leaving their normal
  // surfaces. Defaulted to super_admin only at provisioning time.
  'admissions.pipeline',
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
});

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
