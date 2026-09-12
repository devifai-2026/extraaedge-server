// Staff leave API.
//
// Self-service carries NO requireRole — every employee applies for their own
// leave, whatever their role, and those handlers resolve req.user.id so they can
// only ever touch the caller's own rows. Approver and admin surfaces are gated.
import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import * as service from './service.js';
import * as repo from './repo.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import {
  ADMIN_TIER_ROLES, MANAGER_TIER_ROLES, LMS_TENANT_ROLES,
} from '../../config/constants.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const APPROVER_ROLES = [...MANAGER_TIER_ROLES, LMS_TENANT_ROLES.HR, LMS_TENANT_ROLES.HR_TEAM_LEAD];
const LEAVE_ADMIN = [...ADMIN_TIER_ROLES, LMS_TENANT_ROLES.HR_TEAM_LEAD];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const idParam = z.object({ id: z.string().uuid() });

const applySchema = z.object({
  leave_type_id: z.string().uuid(),
  from_date: isoDate,
  to_date: isoDate,
  half_day: z.enum(['first_half', 'second_half']).optional().nullable(),
  reason: z.string().min(1).max(500),
  attachment_r2_key: z.string().optional().nullable(),
  // Set only when a manager/HR files on somebody's behalf.
  user_id: z.string().uuid().optional(),
});

const decideSchema = z.object({
  approve: z.boolean(),
  note: z.string().max(500).optional(),
});

const listQuery = z.object({
  status: z.enum(['pending', 'approved', 'declined', 'cancelled']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  user_id: z.string().uuid().optional(),
});

// ---- self-service ---------------------------------------------------------
router.get('/types', async (req, res, next) => {
  try { res.json({ data: await service.listTypes(req.tenant), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});

router.get('/mine', validate({ query: listQuery }), async (req, res, next) => {
  try {
    const data = await service.myLeaves(req.tenant, req.user.id, req.query);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/mine/balances', async (req, res, next) => {
  try {
    const year = Number(req.query.year) || undefined;
    res.json({ data: await service.myBalances(req.tenant, req.user.id, year), meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// What chain WILL apply, so the form can show it before anyone submits.
router.get('/mine/approval-chain', async (req, res, next) => {
  try {
    const { rows: [me] } = await import('../../db/tenant.js')
      .then((m) => m.tenantQuery(req.tenant, `SELECT id, role, manager_id FROM users WHERE id = $1`, [req.user.id]));
    const chain = await service.resolveApprovalChain(req.tenant, me);
    res.json({ data: chain, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/', validate({ body: applySchema }), async (req, res, next) => {
  try {
    const leave = await service.applyLeave(req.tenant, req.user, req.body);
    // Auto-approved (mode 'none') consumes the balance immediately.
    if (leave.status === 'approved') await service.commitBalance(req.tenant, leave, req.user.id);
    await writeAuditLog(req.tenant, {
      userId: req.user.id, action: 'leave.applied', entityType: 'staff_leave', entityId: leave.id,
      afterJson: { from: leave.from_date, to: leave.to_date, days: leave.day_count, status: leave.status },
    });
    res.status(201).json({ data: leave, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/:id/cancel', validate({ params: idParam }), async (req, res, next) => {
  try {
    const out = await service.cancel(req.tenant, req.user, req.params.id);
    await writeAuditLog(req.tenant, {
      userId: req.user.id, action: 'leave.cancelled', entityType: 'staff_leave', entityId: req.params.id,
    });
    res.json({ data: out, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const leave = await repo.findLeave(req.tenant, req.params.id);
    if (!leave) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Leave request not found' } });
    // Own request, or an approver/admin surface.
    const mayView = leave.user_id === req.user.id
      || APPROVER_ROLES.includes(req.user.role);
    if (!mayView) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not your leave request' } });
    const steps = await repo.approvalSteps(req.tenant, req.params.id);
    return res.json({ data: { ...leave, steps }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---- approver -------------------------------------------------------------
router.get('/queue/pending', requireRole(...APPROVER_ROLES), async (req, res, next) => {
  try {
    res.json({ data: await service.pendingForApprover(req.tenant, req.user.id), meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/:id/decide', requireRole(...APPROVER_ROLES), validate({ params: idParam, body: decideSchema }), async (req, res, next) => {
  try {
    const out = await service.decide(req.tenant, req.user, req.params.id, req.body);
    // Only charge the balance once the LAST step approves.
    if (out.final && out.status === 'approved') await service.commitBalance(req.tenant, out, req.user.id);
    await writeAuditLog(req.tenant, {
      userId: req.user.id,
      action: req.body.approve ? 'leave.approved' : 'leave.declined',
      entityType: 'staff_leave', entityId: req.params.id,
      afterJson: { final: out.final, status: out.status },
    });
    res.json({ data: out, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---- register / admin -----------------------------------------------------
router.get('/', requireRole(...APPROVER_ROLES), validate({ query: listQuery }), async (req, res, next) => {
  try {
    res.json({ data: await service.listForActor(req.tenant, req.user, req.query), meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/policies', requireRole(...LEAVE_ADMIN), async (req, res, next) => {
  try { res.json({ data: await service.listPolicies(req.tenant), meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});

router.put('/policies/:scope', requireRole(...LEAVE_ADMIN), validate({
  params: z.object({ scope: z.string().min(1) }),
  body: z.object({ approval_mode: z.enum(['two_level', 'hr_only', 'lead_only', 'none']) }),
}), async (req, res, next) => {
  try {
    const out = await service.setPolicy(req.tenant, req.params.scope, req.body.approval_mode);
    await writeAuditLog(req.tenant, {
      userId: req.user.id, action: 'leave.policy_changed', entityType: 'leave_approval_policy',
      entityId: null, afterJson: out,
    });
    res.json({ data: out, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---- holidays -------------------------------------------------------------
router.get('/holidays/list', async (req, res, next) => {
  try {
    res.json({
      data: await service.listHolidays(req.tenant, {
        from: req.query.from, to: req.query.to, branchId: req.query.branch_id,
      }),
      meta: { requestId: req.id },
    });
  } catch (err) { next(err); }
});

// A RANGE in, one row per date out — see service.addHolidays.
router.post('/holidays', requireRole(...LEAVE_ADMIN), validate({
  body: z.object({
    name: z.string().min(1).max(120),
    from_date: isoDate,
    to_date: isoDate.optional(),
    branch_id: z.string().uuid().optional().nullable(),
    is_optional: z.boolean().optional(),
  }),
}), async (req, res, next) => {
  try {
    const created = await service.addHolidays(req.tenant, req.user, req.body);
    await writeAuditLog(req.tenant, {
      userId: req.user.id, action: 'holiday.declared', entityType: 'holiday', entityId: null,
      afterJson: { name: req.body.name, dates: created.map((c) => c.date) },
    });
    res.status(201).json({ data: created, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/holidays/:id', requireRole(...LEAVE_ADMIN), validate({ params: idParam }), async (req, res, next) => {
  try {
    await service.removeHoliday(req.tenant, req.params.id);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
