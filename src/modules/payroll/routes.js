// Payroll API.
//
// Route ORDER matters: every literal path is declared before any ':id' route,
// because Express matches in declaration order and a ':id' above '/settings'
// would swallow it and fail uuid validation with a 400. (That exact bug was
// live in staff-leave — see its routes.js.)
//
// Authority is NOT a tab check. branch_manager holds the '*' tab wildcard, so a
// tab-only gate would expose every salary in the org. The per-row rules live in
// service.assertMaySeeSalary / assertMayDisburse.
import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import * as service from './service.js';
import { writeAuditLog } from '../../lib/auditLog.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const money = z.number().min(0).max(99999999);

const ok = (res, req, data, status = 200) =>
  res.status(status).json({ data, meta: { requestId: req.id } });

// ---- self-service (no role gate; own rows only) ---------------------------
router.get('/my/payslips', async (req, res, next) => {
  try { ok(res, req, await service.myPayslips(req.tenant, req.user.id)); }
  catch (e) { next(e); }
});

// ---- pay heads ------------------------------------------------------------
router.get('/components', async (req, res, next) => {
  try { ok(res, req, await service.listComponents(req.tenant)); }
  catch (e) { next(e); }
});

router.patch('/components/:id', validate({
  params: idParam,
  body: z.object({
    name: z.string().min(1).max(120).optional(),
    default_value: money.optional(),
    unit_label: z.string().max(40).nullable().optional(),
    is_taxable: z.boolean().optional(),
    affects_lop: z.boolean().optional(),
    is_active: z.boolean().optional(),
    order_index: z.number().int().optional(),
  }),
}), async (req, res, next) => {
  try {
    const out = await service.updateComponent(req.tenant, req.user, req.params.id, req.body);
    await writeAuditLog(req.tenant, {
      userId: req.user.id, action: 'payroll.component_updated',
      entityType: 'salary_component', entityId: req.params.id, afterJson: out,
    });
    ok(res, req, out);
  } catch (e) { next(e); }
});

// ---- incentive slabs ------------------------------------------------------
router.get('/slabs', async (req, res, next) => {
  try { ok(res, req, await service.listSlabs(req.tenant, req.user)); }
  catch (e) { next(e); }
});

router.post('/slabs', validate({
  body: z.object({
    id: uuid.optional(),
    component_id: uuid,
    user_id: uuid.nullable().optional(),
    role_scope: z.string().max(40).nullable().optional(),
    min_units: z.number().min(0).optional(),
    max_units: z.number().min(0).nullable().optional(),
    amount_per_unit: money.optional(),
    flat_amount: money.optional(),
    is_active: z.boolean().optional(),
  }),
}), async (req, res, next) => {
  try {
    const out = await service.saveSlab(req.tenant, req.user, req.body);
    await writeAuditLog(req.tenant, {
      userId: req.user.id, action: 'payroll.slab_saved',
      entityType: 'incentive_slab', entityId: out.id, afterJson: out,
    });
    ok(res, req, out, req.body.id ? 200 : 201);
  } catch (e) { next(e); }
});

router.delete('/slabs/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    await service.removeSlab(req.tenant, req.user, req.params.id);
    await writeAuditLog(req.tenant, {
      userId: req.user.id, action: 'payroll.slab_deleted',
      entityType: 'incentive_slab', entityId: req.params.id,
    });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ---- structures -----------------------------------------------------------
router.get('/structures', validate({ query: z.object({ user_id: uuid.optional() }) }), async (req, res, next) => {
  try { ok(res, req, await service.listStructures(req.tenant, req.user, req.query)); }
  catch (e) { next(e); }
});

router.get('/structures/:userId', validate({
  params: z.object({ userId: uuid }),
  query: z.object({ on_date: isoDate.optional() }),
}), async (req, res, next) => {
  try { ok(res, req, await service.getStructure(req.tenant, req.user, req.params.userId, req.query.on_date ?? null)); }
  catch (e) { next(e); }
});

router.post('/structures', validate({
  body: z.object({
    user_id: uuid,
    effective_from: isoDate,
    annual_ctc: money.optional(),
    monthly_gross: money.optional(),
    notes: z.string().max(500).optional(),
    components: z.array(z.object({
      component_id: uuid,
      amount: money.nullable().optional(),
      percent: z.number().min(0).max(100).nullable().optional(),
      rate: money.nullable().optional(),
      default_units: z.number().min(0).max(999).optional(),
    })).default([]),
  }),
}), async (req, res, next) => {
  try {
    const out = await service.saveStructure(req.tenant, req.user, req.body);
    await writeAuditLog(req.tenant, {
      userId: req.user.id, action: 'payroll.structure_saved',
      entityType: 'employee_salary_structure', entityId: out.id,
      afterJson: { user_id: req.body.user_id, effective_from: req.body.effective_from, annual_ctc: req.body.annual_ctc },
    });
    ok(res, req, out, 201);
  } catch (e) { next(e); }
});

// ---- settings -------------------------------------------------------------
router.get('/settings', async (req, res, next) => {
  try { ok(res, req, await service.getSettings(req.tenant, req.user)); }
  catch (e) { next(e); }
});

router.put('/settings', validate({
  body: z.object({
    pay_day_of_month: z.number().int().min(1).max(28).optional(),
    reminder_offsets: z.array(z.number().int().min(0).max(30)).max(6).optional(),
    notify_on_complete: z.boolean().optional(),
  }),
}), async (req, res, next) => {
  try {
    const out = await service.saveSettings(req.tenant, req.user, req.body);
    await writeAuditLog(req.tenant, {
      userId: req.user.id, action: 'payroll.settings_updated',
      entityType: 'payroll_settings', entityId: null, afterJson: out,
    });
    ok(res, req, out);
  } catch (e) { next(e); }
});

// ---- runs -----------------------------------------------------------------
router.get('/runs', async (req, res, next) => {
  try { ok(res, req, await service.listRuns(req.tenant, req.user)); }
  catch (e) { next(e); }
});

router.post('/runs', validate({
  body: z.object({
    period_year: z.number().int().min(2020).max(2100),
    period_month: z.number().int().min(1).max(12),
    branch_id: uuid.nullable().optional(),
    pay_date: isoDate.optional(),
  }),
}), async (req, res, next) => {
  try {
    const out = await service.createRun(req.tenant, req.user, req.body);
    await writeAuditLog(req.tenant, {
      userId: req.user.id, action: 'payroll.run_created',
      entityType: 'payroll_run', entityId: out.id, afterJson: out,
    });
    ok(res, req, out, 201);
  } catch (e) { next(e); }
});

router.post('/runs/:id/compute', validate({ params: idParam }), async (req, res, next) => {
  try {
    const out = await service.compute(req.tenant, req.user, req.params.id);
    await writeAuditLog(req.tenant, {
      userId: req.user.id, action: 'payroll.run_computed',
      entityType: 'payroll_run', entityId: req.params.id,
      afterJson: { employee_count: out.employee_count, total_net: out.total_net },
    });
    ok(res, req, out);
  } catch (e) { next(e); }
});

router.get('/runs/:id/payslips', validate({ params: idParam }), async (req, res, next) => {
  try { ok(res, req, await service.payslipsForRun(req.tenant, req.user, req.params.id)); }
  catch (e) { next(e); }
});

router.post('/runs/:id/approve', validate({ params: idParam }), async (req, res, next) => {
  try {
    const out = await service.approveRun(req.tenant, req.user, req.params.id);
    await writeAuditLog(req.tenant, {
      userId: req.user.id, action: 'payroll.run_approved',
      entityType: 'payroll_run', entityId: req.params.id, afterJson: out,
    });
    ok(res, req, out);
  } catch (e) { next(e); }
});

router.get('/runs/:id/disbursements', validate({ params: idParam }), async (req, res, next) => {
  try { ok(res, req, await service.disbursements(req.tenant, req.user, req.params.id)); }
  catch (e) { next(e); }
});

// ---- disbursement ---------------------------------------------------------
// super_admin only: the person who computes a run must not be the one who pays
// it. Enforced in service.assertMayDisburse, not by a tab.
router.post('/disbursements/:id/mark-paid', validate({
  params: idParam,
  body: z.object({
    reference_no: z.string().max(120).optional(),
    proof_r2_key: z.string().max(500).optional(),
    notes: z.string().max(500).optional(),
  }),
}), async (req, res, next) => {
  try {
    const out = await service.markPaid(req.tenant, req.user, req.params.id, req.body);
    await writeAuditLog(req.tenant, {
      userId: req.user.id, action: 'payroll.marked_paid',
      entityType: 'payroll_disbursement', entityId: req.params.id,
      afterJson: { amount: out.amount, reference_no: out.reference_no, run_completed: out.completed },
    });
    ok(res, req, out);
  } catch (e) { next(e); }
});

// ---- single payslip (LAST — see the header note on route order) -----------
router.get('/payslips/:id', validate({ params: idParam }), async (req, res, next) => {
  try { ok(res, req, await service.myPayslip(req.tenant, req.user, req.params.id)); }
  catch (e) { next(e); }
});

export default router;
