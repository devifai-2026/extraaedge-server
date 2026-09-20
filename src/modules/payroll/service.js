// Payroll business rules.
//
// Access is the hard part here, and it is deliberately NOT a tab check:
// branch_manager holds the '*' tab wildcard, so a tab-only gate would hand the
// whole org's salaries to every BM. Salary visibility is decided per row, by
// the rules in assertMaySeeSalary below.
//
// Segregation of duties: HR computes and approves a run, but only super_admin
// can mark money as paid.
import { conflict, forbidden, notFound, validationError } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES, LMS_TENANT_ROLES } from '../../config/constants.js';
import { tenantQuery } from '../../db/tenant.js';
import * as repo from './repo.js';
import { computePayslip } from './calc.js';
import { unitsFor, workingDays } from './units.js';

// Who may compute payroll and see everybody's numbers.
//
// NOT ADMIN_TIER_ROLES: that set includes branch_manager, and salary is money.
// A branch manager approves registration amounts and nothing else — they keep
// their own payslip (handled by the self-service path below), but the whole
// org's salaries are for super_admin and the HR side.
//
// hr_recruiter is included because payroll management is part of that role's
// brief (recruitment & staffing: hire, onboard, then run their leave and pay).
// Computing a run is not the same as paying it — DISBURSE_ROLES below stays
// super_admin only, so the person who prepares payroll still cannot release
// the money.
export const PAYROLL_ADMIN_ROLES = [
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
  LMS_TENANT_ROLES.HR_TEAM_LEAD,
  LMS_TENANT_ROLES.HR_RECRUITER,
];
// Who may release money. Narrower on purpose — the person who computes a run
// must not also be the person who pays it.
export const DISBURSE_ROLES = [SYSTEM_TENANT_ROLES.SUPER_ADMIN];

export const isPayrollAdmin = (role) => PAYROLL_ADMIN_ROLES.includes(role);

// Impersonated sessions never see salary, whatever the role says.
const assertNotImpersonated = (actor) => {
  if (actor?.impersonated || actor?.sudo || actor?.impersonator_id) {
    throw forbidden('Salary data is not available in an impersonated session');
  }
};

export const assertMaySeeSalary = (actor, subjectUserId) => {
  assertNotImpersonated(actor);
  if (subjectUserId && subjectUserId === actor.id) return;      // your own
  if (isPayrollAdmin(actor.role)) return;
  // Line managers get leave and attendance for their team, and no salary at
  // all — knowing what your reports earn is a different privilege from
  // approving their leave.
  throw forbidden('You do not have access to salary data');
};

export const assertMayDisburse = (actor) => {
  assertNotImpersonated(actor);
  if (!DISBURSE_ROLES.includes(actor.role)) {
    throw forbidden('Only a super admin can release salary payments');
  }
};

// ---- chart of pay heads ---------------------------------------------------
export const listComponents = (tenant) => repo.listComponents(tenant);

export const updateComponent = async (tenant, actor, id, patch) => {
  if (!isPayrollAdmin(actor.role)) throw forbidden('Not allowed to edit pay heads');
  const allowed = ['name', 'default_value', 'unit_label', 'is_taxable', 'affects_lop', 'is_active', 'order_index'];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  // calc_type and kind are deliberately NOT editable: changing a head from
  // earning to deduction, or fixed to per_unit, would silently reinterpret
  // every structure already referencing it.
  const out = await repo.updateComponent(tenant, id, clean);
  if (!out) throw notFound('Pay head not found');
  return out;
};

// ---- structures -----------------------------------------------------------
export const getStructure = async (tenant, actor, userId, onDate = null) => {
  assertMaySeeSalary(actor, userId);
  const s = await repo.currentStructure(tenant, userId, onDate);
  if (!s) return null;
  const components = await repo.structureComponents(tenant, s.id);
  if (userId !== actor.id) {
    await repo.logAccess(tenant, {
      actorId: actor.id, subjectUserId: userId, action: 'structure.view',
      entityType: 'employee_salary_structure', entityId: s.id,
    });
  }
  return { ...s, components };
};

export const listStructures = async (tenant, actor, filters = {}) => {
  assertMaySeeSalary(actor, filters.user_id ?? null);
  return repo.listStructures(tenant, { userId: filters.user_id ?? null });
};

export const saveStructure = async (tenant, actor, input) => {
  if (!isPayrollAdmin(actor.role)) throw forbidden('Not allowed to set salary structures');

  // A structure that is already paid against must not be rewritten — the
  // payslip snapshot would then disagree with the structure it cites.
  const { rows: [paid] } = await tenantQuery(
    tenant,
    `SELECT count(*)::int AS n FROM payslips
      WHERE user_id = $1 AND status = 'paid'
        AND make_date(period_year, period_month, 1) >= date_trunc('month', $2::date)`,
    [input.user_id, input.effective_from],
  );
  if (Number(paid.n) > 0) {
    throw conflict('This employee already has a PAID payslip from that month onward. Choose a later effective date.');
  }

  const out = await repo.saveStructure(tenant, {
    userId: input.user_id,
    effectiveFrom: input.effective_from,
    annualCtc: input.annual_ctc,
    monthlyGross: input.monthly_gross,
    notes: input.notes,
    components: input.components,
    actorId: actor.id,
  });
  await repo.logAccess(tenant, {
    actorId: actor.id, subjectUserId: input.user_id, action: 'structure.save',
    entityType: 'employee_salary_structure', entityId: out.id,
  });
  return out;
};

// ---- slabs ----------------------------------------------------------------
export const listSlabs = async (tenant, actor) => {
  if (!isPayrollAdmin(actor.role)) throw forbidden('Not allowed to view incentive slabs');
  return repo.listSlabs(tenant);
};

export const saveSlab = async (tenant, actor, input) => {
  if (!isPayrollAdmin(actor.role)) throw forbidden('Not allowed to edit incentive slabs');
  if (input.max_units != null && Number(input.max_units) < Number(input.min_units ?? 0)) {
    throw validationError({ max_units: 'max_units cannot be below min_units' });
  }
  if (!input.user_id && !input.role_scope) {
    throw validationError({ role_scope: 'A slab must target either a role or a specific employee' });
  }
  return repo.upsertSlab(tenant, input);
};

export const removeSlab = async (tenant, actor, id) => {
  if (!isPayrollAdmin(actor.role)) throw forbidden('Not allowed to edit incentive slabs');
  await repo.deleteSlab(tenant, id);
};

// Pick the slab whose band contains `units`. A user-specific slab outranks a
// role-wide one; within the same specificity the highest matching min_units
// wins, so bands can be declared in any order.
export const pickSlab = (slabs, code, units) => {
  const candidates = (slabs || [])
    .filter((s) => s.code === code
      && Number(units) >= Number(s.min_units ?? 0)
      && (s.max_units == null || Number(units) <= Number(s.max_units)))
    .sort((a, b) => {
      const spec = (b.user_id ? 1 : 0) - (a.user_id ? 1 : 0);
      if (spec !== 0) return spec;
      return Number(b.min_units ?? 0) - Number(a.min_units ?? 0);
    });
  return candidates[0] ?? null;
};

// ---- runs -----------------------------------------------------------------
const monthWindow = (year, month) => {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from, to: `${year}-${String(month).padStart(2, '0')}-${last}` };
};

export const listRuns = async (tenant, actor) => {
  if (!isPayrollAdmin(actor.role)) throw forbidden('Not allowed to view payroll runs');
  return repo.listRuns(tenant);
};

export const createRun = async (tenant, actor, { period_year, period_month, branch_id, pay_date }) => {
  if (!isPayrollAdmin(actor.role)) throw forbidden('Not allowed to create a payroll run');
  const existing = await repo.findRunByPeriod(tenant, period_year, period_month, branch_id ?? null);
  if (existing) throw conflict(`A payroll run for ${period_month}/${period_year} already exists`, { run_id: existing.id });

  // Default the pay date from tenant policy when the caller doesn't set one.
  let payDate = pay_date ?? null;
  if (!payDate) {
    const cfg = await repo.settings(tenant);
    const next = period_month === 12
      ? { y: period_year + 1, m: 1 }
      : { y: period_year, m: period_month + 1 };
    payDate = `${next.y}-${String(next.m).padStart(2, '0')}-${String(cfg.pay_day_of_month).padStart(2, '0')}`;
  }
  return repo.createRun(tenant, {
    year: period_year, month: period_month, branchId: branch_id ?? null,
    payDate, actorId: actor.id,
  });
};

// Compute (or recompute) every payslip in a run.
//
// Recompute is allowed only while the run is draft/processing: once approved or
// paid the numbers are history, and the payslip's `components` snapshot is the
// record — never re-derived, or a later raise would rewrite last month.
export const compute = async (tenant, actor, runId) => {
  if (!isPayrollAdmin(actor.role)) throw forbidden('Not allowed to run payroll');
  const run = await repo.findRun(tenant, runId);
  if (!run) throw notFound('Payroll run not found');
  // 'review' is recomputable on purpose: finding a wrong number and fixing it
  // BEFORE approval is the entire point of a review step. Once approved or
  // paid the figures are history and the payslip snapshot is the record.
  if (!['draft', 'processing', 'review'].includes(run.status)) {
    throw conflict(`This run is ${run.status} and can no longer be recomputed`);
  }

  const { from, to } = monthWindow(run.period_year, run.period_month);

  // Everyone with an active structure covering this month, optionally branched.
  const params = [to];
  let branchCond = '';
  if (run.branch_id) { params.push(run.branch_id); branchCond = `AND u.branch_id = $${params.length}`; }
  const { rows: staff } = await tenantQuery(
    tenant,
    `SELECT DISTINCT ON (u.id) u.id, u.name, u.role, s.id AS structure_id
       FROM users u
       JOIN employee_salary_structures s ON s.user_id = u.id
        AND s.deleted_at IS NULL AND s.status <> 'draft'
        AND s.effective_from <= $1::date
        AND (s.effective_to IS NULL OR s.effective_to >= $1::date)
      WHERE u.deleted_at IS NULL ${branchCond}
      ORDER BY u.id, s.effective_from DESC`,
    params,
  );
  if (!staff.length) {
    throw conflict('Nobody has an active salary structure for this month. Set structures first.');
  }

  const userIds = staff.map((s) => s.id);
  const [units, wDays] = await Promise.all([
    unitsFor(tenant, { userIds, from, to }),
    workingDays(tenant, { from, to }),
  ]);

  const slips = [];
  for (const person of staff) {
    // eslint-disable-next-line no-await-in-loop
    const [comps, slabs] = await Promise.all([
      repo.structureComponents(tenant, person.structure_id),
      repo.slabsFor(tenant, { userId: person.id, role: person.role }),
    ]);
    const mine = units[person.id] || {};

    const withUnits = comps.map((c) => ({
      code: c.code,
      name: c.name,
      kind: c.kind,
      calc_type: c.calc_type,
      amount: c.amount,
      percent: c.percent,
      rate: c.rate,
      affects_lop: c.affects_lop,
      // Actuals beat the structure's expected count. A structure may say "2
      // extra classes a month"; what gets paid is what was actually taught.
      units: mine[c.code] ?? c.default_units ?? 0,
    }));

    const lop = Number(mine.LOP ?? 0);
    const result = computePayslip({
      components: withUnits,
      workingDays: wDays,
      lopDays: lop,
      slabsFor: (code, u) => pickSlab(slabs, code, u),
    });

    slips.push({
      user_id: person.id,
      structure_id: person.structure_id,
      period_month: run.period_month,
      period_year: run.period_year,
      working_days: wDays,
      present_days: Math.max(0, wDays - lop),
      paid_leave_days: 0,
      lop_days: lop,
      gross_earnings: result.gross_earnings,
      total_deductions: result.total_deductions,
      net_pay: result.net_pay,
      components: result.components,
      units_snapshot: mine,
    });
  }

  await repo.replacePayslips(tenant, runId, slips);
  await repo.setRunStatus(tenant, runId, 'review');
  await repo.logAccess(tenant, {
    actorId: actor.id, subjectUserId: null, action: 'run.compute',
    entityType: 'payroll_run', entityId: runId,
  });
  return repo.findRun(tenant, runId);
};

export const payslipsForRun = async (tenant, actor, runId) => {
  if (!isPayrollAdmin(actor.role)) throw forbidden('Not allowed to view payslips');
  await repo.logAccess(tenant, {
    actorId: actor.id, subjectUserId: null, action: 'run.view_payslips',
    entityType: 'payroll_run', entityId: runId,
  });
  return repo.listPayslips(tenant, runId);
};

// Approving freezes the numbers and opens the disbursement rows + reminders.
export const approveRun = async (tenant, actor, runId) => {
  if (!isPayrollAdmin(actor.role)) throw forbidden('Not allowed to approve payroll');
  const run = await repo.findRun(tenant, runId);
  if (!run) throw notFound('Payroll run not found');
  if (run.status !== 'review') throw conflict(`Only a run in review can be approved (this one is ${run.status})`);
  if (!run.employee_count) throw conflict('This run has no payslips — compute it first');

  const updated = await repo.setRunStatus(tenant, runId, 'approved', {
    approved_by: actor.id, approved_at: new Date().toISOString(), locked_at: new Date().toISOString(),
  });
  await tenantQuery(tenant, `UPDATE payslips SET status = 'finalised', updated_at = now() WHERE run_id = $1 AND status = 'draft'`, [runId]);
  await repo.openDisbursements(tenant, runId, run.pay_date);

  const cfg = await repo.settings(tenant);
  const offsets = Array.isArray(cfg.reminder_offsets) ? cfg.reminder_offsets : [3, 1, 0];
  if (run.pay_date) await repo.ensureReminders(tenant, runId, run.pay_date, offsets);

  await repo.logAccess(tenant, {
    actorId: actor.id, subjectUserId: null, action: 'run.approve',
    entityType: 'payroll_run', entityId: runId,
  });
  return updated;
};

// ---- disbursement ---------------------------------------------------------
export const disbursements = async (tenant, actor, runId) => {
  if (!isPayrollAdmin(actor.role)) throw forbidden('Not allowed to view disbursements');
  const rows = await repo.listPayslips(tenant, runId);
  const progress = await repo.disbursementProgress(tenant, runId);
  return { rows, progress };
};

// Marking one person paid. Returns `completed: true` exactly once — on the
// payment that finishes the run — so the caller can notify without having to
// guess whether it already did.
export const markPaid = async (tenant, actor, disbursementId, body) => {
  assertMayDisburse(actor);
  const out = await repo.markPaid(tenant, disbursementId, {
    referenceNo: body.reference_no,
    proofKey: body.proof_r2_key,
    notes: body.notes,
    actorId: actor.id,
  });
  if (!out) throw conflict('This payment is already marked paid');

  const progress = await repo.disbursementProgress(tenant, out.run_id);
  await tenantQuery(tenant, `UPDATE payroll_runs SET paid_count = $2, updated_at = now() WHERE id = $1`,
    [out.run_id, progress.paid]);

  let completed = false;
  if (progress.total > 0 && progress.paid === progress.total) {
    // completed_notified_at is the exactly-once guard: the UPDATE only matches
    // while it is still NULL, so a concurrent second call notifies nobody.
    const { rowCount } = await tenantQuery(
      tenant,
      `UPDATE payroll_runs
          SET status = 'paid', completed_notified_at = now(), updated_at = now()
        WHERE id = $1 AND completed_notified_at IS NULL`,
      [out.run_id],
    );
    completed = rowCount > 0;
  }

  await repo.logAccess(tenant, {
    actorId: actor.id, subjectUserId: out.user_id, action: 'disbursement.mark_paid',
    entityType: 'payroll_disbursement', entityId: out.id,
  });
  return { ...out, progress, completed };
};

// ---- self-service ---------------------------------------------------------
// No role gate: resolves the caller's own id and returns finalised slips only.
export const myPayslips = (tenant, userId) => repo.myPayslips(tenant, userId);

export const myPayslip = async (tenant, actor, id) => {
  const slip = await repo.findPayslip(tenant, id);
  if (!slip) throw notFound('Payslip not found');
  if (slip.user_id !== actor.id) {
    assertMaySeeSalary(actor, slip.user_id);
    await repo.logAccess(tenant, {
      actorId: actor.id, subjectUserId: slip.user_id, action: 'payslip.view',
      entityType: 'payslip', entityId: id,
    });
  } else if (!['finalised', 'paid'].includes(slip.status)) {
    // Your own draft payslip is still a work in progress.
    throw forbidden('This payslip has not been published yet');
  }
  return slip;
};

// ---- settings -------------------------------------------------------------
export const getSettings = async (tenant, actor) => {
  if (!isPayrollAdmin(actor.role)) throw forbidden('Not allowed to view payroll settings');
  return repo.settings(tenant);
};

export const saveSettings = async (tenant, actor, patch) => {
  if (!isPayrollAdmin(actor.role)) throw forbidden('Not allowed to edit payroll settings');
  return repo.saveSettings(tenant, patch, actor.id);
};
