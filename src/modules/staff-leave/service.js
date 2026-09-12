// Staff leave business rules: who approves, how many days, what it costs the
// balance, and who may see whose request.
import { tenantQuery, tenantTx } from '../../db/tenant.js';
import * as repo from './repo.js';
import * as usersRepo from '../users/repo.js';
import { conflict, forbidden, notFound, validationError } from '../../lib/errors.js';
import {
  SYSTEM_TENANT_ROLES, LMS_TENANT_ROLES, MANAGER_TIER_ROLES, ADMIN_TIER_ROLES,
} from '../../config/constants.js';

const HR_ROLES = [LMS_TENANT_ROLES.HR, LMS_TENANT_ROLES.HR_TEAM_LEAD];

// Roles that may see and decide any request in the tenant.
const LEAVE_ADMIN_ROLES = [...ADMIN_TIER_ROLES, LMS_TENANT_ROLES.HR_TEAM_LEAD, LMS_TENANT_ROLES.HR];

const isLeaveAdmin = (role) => LEAVE_ADMIN_ROLES.includes(role);

// Whole days, inclusive of both ends. A half-day request is 0.5 regardless of
// span, and the caller is stopped from marking a multi-day request half.
export const computeDayCount = (fromDate, toDate, halfDay) => {
  const a = new Date(`${fromDate}T00:00:00Z`);
  const b = new Date(`${toDate}T00:00:00Z`);
  const days = Math.floor((b - a) / 86400000) + 1;
  if (days < 1) return null;
  if (halfDay) return days === 1 ? 0.5 : null;
  return days;
};

// Resolve the chain for ONE applicant.
//
// The first approver is read from the applicant's ACTUAL reporting line rather
// than a hardcoded role map, so it keeps working when the org changes — which
// is the whole point of making the reporting line editable.
//
//   two_level  direct lead THEN hr          both must approve
//   hr_only    hr alone
//   lead_only  direct lead alone            HR still sees it on the calendar
//   none       auto-approved on submit      the opt-out
export const resolveApprovalChain = async (tenant, applicant) => {
  const mode = await repo.policyFor(tenant, applicant.role);
  if (mode === 'none') return { mode, steps: [] };

  const leadId = applicant.manager_id ?? null;
  // Fall back to a secondary manager before giving up on a lead.
  let resolvedLead = leadId;
  if (!resolvedLead) {
    const ids = await usersRepo.getManagerIds(tenant, applicant.id).catch(() => []);
    resolvedLead = ids?.[0] ?? null;
  }

  const { rows: hrUsers } = await tenantQuery(
    tenant,
    `SELECT id FROM users
      WHERE role = ANY($1) AND is_active = true AND deleted_at IS NULL
      ORDER BY CASE WHEN role = $2 THEN 0 ELSE 1 END, created_at
      LIMIT 1`,
    [HR_ROLES, LMS_TENANT_ROLES.HR_TEAM_LEAD],
  );
  const hrId = hrUsers[0]?.id ?? null;

  const steps = [];
  if (mode === 'two_level') {
    if (resolvedLead) steps.push({ approver_role: 'lead', approver_id: resolvedLead });
    if (hrId) steps.push({ approver_role: 'hr', approver_id: hrId });
  } else if (mode === 'hr_only') {
    if (hrId) steps.push({ approver_role: 'hr', approver_id: hrId });
  } else if (resolvedLead) {
    steps.push({ approver_role: 'lead', approver_id: resolvedLead });
  }

  // Nobody resolvable (a BM with no admin above, a lead-less role) — fall back
  // to the tenant admin rather than stranding the request with no approver.
  if (!steps.length) {
    const { rows: [admin] } = await tenantQuery(
      tenant,
      `SELECT id FROM users WHERE role = $1 AND is_active = true AND deleted_at IS NULL
        ORDER BY created_at LIMIT 1`,
      [SYSTEM_TENANT_ROLES.SUPER_ADMIN],
    );
    if (admin && admin.id !== applicant.id) {
      steps.push({ approver_role: 'admin', approver_id: admin.id });
    }
  }
  return { mode, steps };
};

export const listTypes = (tenant) => repo.listTypes(tenant);

export const myBalances = (tenant, userId, year) =>
  repo.balancesFor(tenant, userId, year ?? new Date().getFullYear());

export const myLeaves = (tenant, userId, { status, from, to } = {}) =>
  repo.listLeaves(tenant, { userIds: [userId], status, from, to });

// Apply. `targetUserId` lets a manager/HR file on somebody's behalf.
export const applyLeave = async (tenant, actor, input) => {
  const targetId = input.user_id && input.user_id !== actor.id ? input.user_id : actor.id;
  if (targetId !== actor.id && !isLeaveAdmin(actor.role) && !MANAGER_TIER_ROLES.includes(actor.role)) {
    throw forbidden('You can only apply for your own leave');
  }

  const applicant = await usersRepo.findById(tenant, targetId);
  if (!applicant) throw notFound('User not found');

  const type = await repo.findType(tenant, input.leave_type_id);
  if (!type) throw notFound('Leave type not found');

  const dayCount = computeDayCount(input.from_date, input.to_date, input.half_day);
  if (dayCount === null) {
    throw validationError({ to_date: 'Invalid range — a half day must be a single date, and to_date cannot precede from_date' });
  }
  if (input.half_day && !type.allow_half_day) {
    throw conflict(`${type.name} cannot be taken as a half day`);
  }

  const clash = await repo.overlapping(tenant, targetId, input.from_date, input.to_date);
  if (clash.length) {
    throw conflict(
      `Overlaps an existing ${clash[0].status} request (${String(clash[0].from_date).slice(0, 10)} to ${String(clash[0].to_date).slice(0, 10)})`,
      { conflicting_leave_id: clash[0].id },
    );
  }

  // Unpaid leave has no quota to exhaust, so it is never balance-blocked.
  if (type.is_paid && Number(type.annual_quota_days) > 0) {
    const year = new Date(`${input.from_date}T00:00:00Z`).getUTCFullYear();
    const balances = await repo.balancesFor(tenant, targetId, year);
    const bal = balances.find((b) => b.leave_type_id === type.id);
    if (bal && bal.available_days < dayCount) {
      throw conflict(
        `Not enough ${type.name}: ${bal.available_days} day(s) available, ${dayCount} requested`,
        { available_days: bal.available_days, requested_days: dayCount },
      );
    }
  }

  const { mode, steps } = await resolveApprovalChain(tenant, applicant);
  const autoApprove = mode === 'none' || !type.requires_approval;

  return tenantTx(tenant, async (client) => {
    const leave = await repo.insertLeave(tenant, {
      user_id: targetId,
      leave_type_id: type.id,
      from_date: input.from_date,
      to_date: input.to_date,
      day_count: dayCount,
      half_day: input.half_day ?? null,
      reason: input.reason,
      attachment_r2_key: input.attachment_r2_key,
      applied_via: targetId === actor.id ? 'self' : 'manager',
      status: autoApprove ? 'approved' : 'pending',
      created_by: actor.id,
    }, client);

    if (!autoApprove) await repo.insertApprovalSteps(tenant, leave.id, steps, client);
    return { ...leave, approval_mode: mode, steps_required: steps.length };
  });
};

// Approve or decline ONE step. The request only flips to approved when every
// step has, which is what makes a two-level chain real.
// `mark_lop` / `lop_days` let the APPROVER decide the absence is unpaid, which
// is a separate judgement from which leave type was requested: a counsellor may
// apply as Casual Leave and the lead still approves it as loss of pay.
// Payroll reads `lop_days` off approved rows, so this is the single switch that
// moves money.
export const decide = async (tenant, actor, leaveId, { approve, note, mark_lop, lop_days, lop_note }) => {
  const leave = await repo.findLeave(tenant, leaveId);
  if (!leave) throw notFound('Leave request not found');
  if (leave.status !== 'pending') throw conflict(`This request is already ${leave.status}`);

  // Nobody approves their own leave — including an admin, deliberately.
  if (leave.user_id === actor.id) throw forbidden('You cannot decide your own leave request');

  const steps = await repo.approvalSteps(tenant, leaveId);
  const mine = steps.find((s) => s.status === 'pending'
    && (s.approver_id === actor.id || isLeaveAdmin(actor.role)));
  if (!mine) throw forbidden('This request is not awaiting your decision');

  if (!approve && !note) {
    throw validationError({ note: 'A note is required when declining' });
  }

  // Resolve loss of pay. Default follows the leave TYPE (LWP is unpaid); an
  // explicit mark_lop from the approver overrides it either way.
  const fullDays = Number(leave.day_count ?? 0);
  const typeUnpaid = leave.type_is_paid === false;
  const isLop = mark_lop === undefined || mark_lop === null ? typeUnpaid : Boolean(mark_lop);
  let lopDays = 0;
  if (isLop) {
    lopDays = lop_days === undefined || lop_days === null ? fullDays : Number(lop_days);
    if (!Number.isFinite(lopDays) || lopDays < 0 || lopDays > fullDays) {
      throw validationError({ lop_days: `Unpaid days must be between 0 and ${fullDays}` });
    }
    // Half-days only ever move in 0.5 steps; anything else is a typo.
    if (Math.round(lopDays * 2) !== lopDays * 2) {
      throw validationError({ lop_days: 'Unpaid days must be in steps of 0.5' });
    }
  }

  return tenantTx(tenant, async (client) => {
    await repo.decideStep(tenant, mine.id, approve ? 'approved' : 'declined', note, client);

    // A single decline ends it; approval needs every step.
    if (!approve) {
      const out = await repo.setLeaveStatus(tenant, leaveId, 'declined', note, client);
      return { ...out, final: true };
    }
    const after = steps.map((s) => (s.id === mine.id ? { ...s, status: 'approved' } : s));
    const allDone = after.every((s) => s.status === 'approved');
    if (!allDone) {
      return { ...leave, status: 'pending', final: false, awaiting: after.filter((s) => s.status === 'pending').length };
    }
    const out = await repo.setLeaveStatus(tenant, leaveId, 'approved', note, client);
    await repo.setLeaveLop(tenant, leaveId, { isLop, lopDays, lopNote: lop_note ?? null }, client);
    return { ...out, is_lop: isLop, lop_days: lopDays, final: true };
  });
};

// Consume the balance once a request is actually approved — never on apply, or
// a declined request would silently cost somebody their quota.
export const commitBalance = async (tenant, leave, actorId) => {
  if (leave.status !== 'approved' || !leave.leave_type_id) return;
  const year = new Date(leave.from_date).getUTCFullYear();
  // Days the approver marked as loss of pay do NOT consume paid quota —
  // charging the balance AND docking the salary would penalise twice for one
  // absence. Only the paid remainder comes off the balance.
  const chargeable = Math.max(0, Number(leave.day_count ?? 0) - Number(leave.lop_days ?? 0));
  if (chargeable <= 0) return;
  await repo.adjustBalance(tenant, {
    userId: leave.user_id,
    leaveTypeId: leave.leave_type_id,
    year,
    delta: chargeable,
    reason: 'approved',
    leaveId: leave.id,
    actorId,
  });
};

export const cancel = async (tenant, actor, leaveId) => {
  const leave = await repo.findLeave(tenant, leaveId);
  if (!leave) throw notFound('Leave request not found');
  if (leave.user_id !== actor.id && !isLeaveAdmin(actor.role)) {
    throw forbidden('You can only cancel your own leave');
  }
  if (!['pending', 'approved'].includes(leave.status)) {
    throw conflict(`Cannot cancel a ${leave.status} request`);
  }
  // Refund an approved day that is being cancelled.
  if (leave.status === 'approved' && leave.leave_type_id) {
    await repo.adjustBalance(tenant, {
      userId: leave.user_id,
      leaveTypeId: leave.leave_type_id,
      year: new Date(leave.from_date).getUTCFullYear(),
      delta: -Number(leave.day_count),
      reason: 'cancelled',
      leaveId: leave.id,
      actorId: actor.id,
    });
  }
  return repo.cancelLeave(tenant, leaveId);
};

export const pendingForApprover = (tenant, userId) => repo.pendingFor(tenant, userId);

// Team / org view. Admin + HR see everything; a manager sees their subtree.
export const listForActor = async (tenant, actor, filters) => {
  if (isLeaveAdmin(actor.role)) return repo.listLeaves(tenant, { ...filters, userIds: null });
  if (MANAGER_TIER_ROLES.includes(actor.role)) {
    const ids = await usersRepo.teamHierarchyMulti(tenant, actor.id);
    return repo.listLeaves(tenant, { ...filters, userIds: ids });
  }
  return repo.listLeaves(tenant, { ...filters, userIds: [actor.id] });
};

// The shared org calendar. Every staff role may read it — see repo.calendarRows
// for why that is safe (name/date/status only, never the reason).
export const calendar = (tenant, filters) => repo.calendarRows(tenant, filters);

export const listPolicies = (tenant) => repo.listPolicies(tenant);
export const setPolicy = (tenant, scope, mode) => repo.setPolicy(tenant, scope, mode);

// ---- holidays -------------------------------------------------------------
export const listHolidays = (tenant, filters) => repo.listHolidays(tenant, filters);

// A span becomes ONE ROW PER DATE so the attendance engine can ask with a plain
// equality. Ganesh Puja across three days is three rows, one name.
export const addHolidays = async (tenant, actor, { name, from_date, to_date, branch_id, is_optional }) => {
  const start = new Date(`${from_date}T00:00:00Z`);
  const end = new Date(`${to_date || from_date}T00:00:00Z`);
  if (end < start) throw validationError({ to_date: 'to_date cannot precede from_date' });
  const days = Math.floor((end - start) / 86400000) + 1;
  if (days > 31) throw validationError({ to_date: 'A holiday span cannot exceed 31 days' });

  const created = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    // eslint-disable-next-line no-await-in-loop
    const row = await repo.insertHoliday(tenant, {
      name, date: d, branchId: branch_id, isOptional: is_optional, actorId: actor.id,
    });
    if (row) created.push(row);
  }
  return created;
};

export const removeHoliday = (tenant, id) => repo.deleteHoliday(tenant, id);
