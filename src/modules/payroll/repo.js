// Payroll data access. Raw SQL, tenant-scoped, no business rules.
import { tenantQuery, tenantTx } from '../../db/tenant.js';

// ---- chart of pay heads ---------------------------------------------------
export const listComponents = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, code, name, kind, calc_type, unit_label, default_value,
            is_taxable, affects_lop, applies_to, order_index, is_active
       FROM salary_components
      WHERE deleted_at IS NULL
      ORDER BY order_index, name`,
  );
  return rows;
};

export const updateComponent = async (tenant, id, patch) => {
  const sets = [];
  const params = [id];
  for (const [col, val] of Object.entries(patch)) {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return null;
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE salary_components SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    params,
  );
  return rows[0] ?? null;
};

// ---- structures -----------------------------------------------------------
const STRUCT_COLS = `
  s.id, s.user_id, s.effective_from, s.effective_to, s.annual_ctc, s.monthly_gross,
  s.status, s.notes, s.created_at, s.approved_at,
  u.name AS user_name, u.role AS user_role, u.email AS user_email
`;

// The structure in force on a given date. effective_to IS NULL means current.
export const currentStructure = async (tenant, userId, onDate = null) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${STRUCT_COLS}
       FROM employee_salary_structures s
       JOIN users u ON u.id = s.user_id
      WHERE s.user_id = $1 AND s.deleted_at IS NULL AND s.status <> 'draft'
        AND s.effective_from <= COALESCE($2::date, current_date)
        AND (s.effective_to IS NULL OR s.effective_to >= COALESCE($2::date, current_date))
      ORDER BY s.effective_from DESC
      LIMIT 1`,
    [userId, onDate],
  );
  return rows[0] ?? null;
};

export const listStructures = async (tenant, { userId = null } = {}) => {
  const params = [];
  let cond = '';
  if (userId) { params.push(userId); cond = `AND s.user_id = $${params.length}`; }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${STRUCT_COLS}
       FROM employee_salary_structures s
       JOIN users u ON u.id = s.user_id
      WHERE s.deleted_at IS NULL ${cond}
      ORDER BY u.name, s.effective_from DESC`,
    params,
  );
  return rows;
};

export const structureComponents = async (tenant, structureId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT esc.id, esc.component_id, esc.amount, esc.percent, esc.rate, esc.default_units,
            c.code, c.name, c.kind, c.calc_type, c.unit_label, c.affects_lop, c.order_index
       FROM employee_salary_components esc
       JOIN salary_components c ON c.id = esc.component_id
      WHERE esc.structure_id = $1 AND c.deleted_at IS NULL
      ORDER BY c.order_index, c.name`,
    [structureId],
  );
  return rows;
};

// A structure is NEVER edited in place. Saving closes the previous version and
// opens a new one, so a payslip issued last month still explains itself.
export const saveStructure = (tenant, { userId, effectiveFrom, annualCtc, monthlyGross, notes, components, actorId }) =>
  tenantTx(tenant, async (client) => {
    await client.query(
      `UPDATE employee_salary_structures
          SET effective_to = ($2::date - 1), status = 'superseded', updated_at = now()
        WHERE user_id = $1 AND deleted_at IS NULL AND effective_to IS NULL
          AND effective_from < $2::date`,
      [userId, effectiveFrom],
    );

    const { rows: [s] } = await client.query(
      `INSERT INTO employee_salary_structures
         (user_id, effective_from, annual_ctc, monthly_gross, notes, status, created_by)
       VALUES ($1,$2,$3,$4,$5,'active',$6)
       ON CONFLICT (user_id, effective_from) DO UPDATE
         SET annual_ctc = EXCLUDED.annual_ctc,
             monthly_gross = EXCLUDED.monthly_gross,
             notes = EXCLUDED.notes,
             status = 'active',
             effective_to = NULL,
             updated_at = now()
       RETURNING *`,
      [userId, effectiveFrom, annualCtc ?? 0, monthlyGross ?? 0, notes ?? null, actorId ?? null],
    );

    await client.query(`DELETE FROM employee_salary_components WHERE structure_id = $1`, [s.id]);
    for (const c of components || []) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO employee_salary_components
           (structure_id, component_id, amount, percent, rate, default_units)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [s.id, c.component_id, c.amount ?? null, c.percent ?? null, c.rate ?? null, c.default_units ?? 0],
      );
    }
    return s;
  });

// ---- incentive slabs ------------------------------------------------------
// Most specific wins: a slab for THIS user beats one for their role.
export const slabsFor = async (tenant, { userId, role }) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id, s.component_id, s.user_id, s.role_scope, s.min_units, s.max_units,
            s.amount_per_unit, s.flat_amount, c.code
       FROM incentive_slabs s
       JOIN salary_components c ON c.id = s.component_id
      WHERE s.deleted_at IS NULL AND s.is_active
        AND (s.user_id = $1 OR (s.user_id IS NULL AND s.role_scope = $2))
      ORDER BY c.code, (s.user_id IS NOT NULL) DESC, s.min_units`,
    [userId, role],
  );
  return rows;
};

export const listSlabs = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.id, s.component_id, s.user_id, s.role_scope, s.min_units, s.max_units,
            s.amount_per_unit, s.flat_amount, s.is_active, c.code, c.name AS component_name,
            u.name AS user_name
       FROM incentive_slabs s
       JOIN salary_components c ON c.id = s.component_id
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.deleted_at IS NULL
      ORDER BY c.order_index, s.role_scope NULLS LAST, s.min_units`,
  );
  return rows;
};

export const upsertSlab = async (tenant, input) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO incentive_slabs
       (id, component_id, user_id, role_scope, min_units, max_units, amount_per_unit, flat_amount, is_active)
     VALUES (COALESCE($1, gen_random_uuid()), $2,$3,$4,$5,$6,$7,$8, COALESCE($9, true))
     ON CONFLICT (id) DO UPDATE
       SET min_units = EXCLUDED.min_units, max_units = EXCLUDED.max_units,
           amount_per_unit = EXCLUDED.amount_per_unit, flat_amount = EXCLUDED.flat_amount,
           is_active = EXCLUDED.is_active, updated_at = now()
     RETURNING *`,
    [input.id ?? null, input.component_id, input.user_id ?? null, input.role_scope ?? null,
      input.min_units ?? 0, input.max_units ?? null, input.amount_per_unit ?? 0,
      input.flat_amount ?? 0, input.is_active],
  );
  return rows[0];
};

export const deleteSlab = (tenant, id) =>
  tenantQuery(tenant, `UPDATE incentive_slabs SET deleted_at = now() WHERE id = $1`, [id]);

// ---- runs + payslips ------------------------------------------------------
export const findRun = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT r.*, u.name AS created_by_name
       FROM payroll_runs r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.id = $1`,
    [id],
  );
  return rows[0] ?? null;
};

export const findRunByPeriod = async (tenant, year, month, branchId = null) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT * FROM payroll_runs
      WHERE period_year = $1 AND period_month = $2
        AND COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND status <> 'cancelled'
      LIMIT 1`,
    [year, month, branchId],
  );
  return rows[0] ?? null;
};

export const listRuns = async (tenant, { limit = 24 } = {}) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT r.*, u.name AS created_by_name
       FROM payroll_runs r LEFT JOIN users u ON u.id = r.created_by
      ORDER BY r.period_year DESC, r.period_month DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
};

export const createRun = async (tenant, { year, month, branchId, payDate, actorId }) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO payroll_runs (period_year, period_month, branch_id, pay_date, status, created_by)
     VALUES ($1,$2,$3,$4,'draft',$5) RETURNING *`,
    [year, month, branchId ?? null, payDate ?? null, actorId ?? null],
  );
  return rows[0];
};

export const setRunStatus = async (tenant, id, status, extra = {}, client) => {
  const q = client ? (t, p) => client.query(t, p) : (t, p) => tenantQuery(tenant, t, p);
  const sets = ['status = $2', 'updated_at = now()'];
  const params = [id, status];
  for (const [col, val] of Object.entries(extra)) {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  const { rows } = await q(
    `UPDATE payroll_runs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params,
  );
  return rows[0] ?? null;
};

// Replace this run's payslips wholesale. Safe because a run can only be
// recomputed while it is draft/processing — see service.compute.
export const replacePayslips = (tenant, runId, slips) =>
  tenantTx(tenant, async (client) => {
    await client.query(`DELETE FROM payslips WHERE run_id = $1`, [runId]);
    for (const s of slips) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO payslips
           (run_id, user_id, structure_id, period_month, period_year,
            working_days, present_days, paid_leave_days, lop_days,
            gross_earnings, total_deductions, net_pay, components, units_snapshot, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft')`,
        [runId, s.user_id, s.structure_id ?? null, s.period_month, s.period_year,
          s.working_days, s.present_days ?? 0, s.paid_leave_days ?? 0, s.lop_days ?? 0,
          s.gross_earnings, s.total_deductions, s.net_pay,
          JSON.stringify(s.components ?? []), JSON.stringify(s.units_snapshot ?? {})],
      );
    }
    const { rows: [tot] } = await client.query(
      `SELECT count(*)::int AS n,
              COALESCE(SUM(gross_earnings),0) AS g,
              COALESCE(SUM(total_deductions),0) AS d,
              COALESCE(SUM(net_pay),0) AS net
         FROM payslips WHERE run_id = $1`,
      [runId],
    );
    await client.query(
      `UPDATE payroll_runs
          SET employee_count = $2, total_gross = $3, total_deductions = $4, total_net = $5,
              updated_at = now()
        WHERE id = $1`,
      [runId, tot.n, tot.g, tot.d, tot.net],
    );
    return tot;
  });

export const listPayslips = async (tenant, runId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT p.*, u.name AS user_name, u.role AS user_role, u.email AS user_email,
            d.status AS disbursement_status, d.paid_at, d.reference_no, d.id AS disbursement_id
       FROM payslips p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN payroll_disbursements d ON d.payslip_id = p.id
      WHERE p.run_id = $1
      ORDER BY u.name`,
    [runId],
  );
  return rows;
};

export const findPayslip = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT p.*, u.name AS user_name, u.role AS user_role, u.email AS user_email,
            d.status AS disbursement_status, d.paid_at, d.reference_no
       FROM payslips p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN payroll_disbursements d ON d.payslip_id = p.id
      WHERE p.id = $1`,
    [id],
  );
  return rows[0] ?? null;
};

// An employee's own payslips. Finalised/paid only — a draft is a work in
// progress and must never be visible to the person it is about.
export const myPayslips = async (tenant, userId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT p.id, p.period_month, p.period_year, p.working_days, p.lop_days,
            p.gross_earnings, p.total_deductions, p.net_pay, p.components, p.status,
            d.status AS disbursement_status, d.paid_at
       FROM payslips p
       LEFT JOIN payroll_disbursements d ON d.payslip_id = p.id
      WHERE p.user_id = $1 AND p.status IN ('finalised','paid')
      ORDER BY p.period_year DESC, p.period_month DESC`,
    [userId],
  );
  return rows;
};

// ---- disbursement ---------------------------------------------------------
export const openDisbursements = (tenant, runId, scheduledDate) =>
  tenantTx(tenant, async (client) => {
    await client.query(
      `INSERT INTO payroll_disbursements (payslip_id, run_id, user_id, amount, scheduled_date)
       SELECT p.id, p.run_id, p.user_id, p.net_pay, $2::date
         FROM payslips p
        WHERE p.run_id = $1
       ON CONFLICT (payslip_id) DO UPDATE
         SET amount = EXCLUDED.amount, scheduled_date = EXCLUDED.scheduled_date, updated_at = now()`,
      [runId, scheduledDate ?? null],
    );
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM payroll_disbursements WHERE run_id = $1`, [runId],
    );
    return rows[0];
  });

export const markPaid = async (tenant, id, { referenceNo, proofKey, notes, actorId }) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE payroll_disbursements
        SET status = 'paid', paid_at = now(), reference_no = $2,
            proof_r2_key = COALESCE($3, proof_r2_key), notes = COALESCE($4, notes),
            marked_by = $5, updated_at = now()
      WHERE id = $1 AND status <> 'paid'
      RETURNING *`,
    [id, referenceNo ?? null, proofKey ?? null, notes ?? null, actorId ?? null],
  );
  if (rows[0]) {
    await tenantQuery(tenant, `UPDATE payslips SET status = 'paid', updated_at = now() WHERE id = $1`, [rows[0].payslip_id]);
  }
  return rows[0] ?? null;
};

// Progress of a run: how many are paid, and is the whole thing done?
export const disbursementProgress = async (tenant, runId) => {
  const { rows: [r] } = await tenantQuery(
    tenant,
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'paid')::int AS paid,
            COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS paid_amount,
            COALESCE(SUM(amount), 0) AS total_amount
       FROM payroll_disbursements WHERE run_id = $1`,
    [runId],
  );
  return r;
};

// ---- reminders ------------------------------------------------------------
// UNIQUE (run_id, offset_days, kind) makes this idempotent: the worker may run
// twice and a reminder still goes out once.
export const ensureReminders = (tenant, runId, payDate, offsets) =>
  tenantTx(tenant, async (client) => {
    for (const off of offsets) {
      const kind = off > 0 ? 'upcoming' : 'due_today';
      // eslint-disable-next-line no-await-in-loop
      // $2 is cast explicitly: used bare it appears both as the stored int and
      // inside date arithmetic, and Postgres refuses to infer two types for one
      // parameter ("inconsistent types deduced for parameter $2").
      await client.query(
        `INSERT INTO payroll_reminders (run_id, offset_days, due_on, kind)
         VALUES ($1, $2::int, ($3::date - $2::int), $4)
         ON CONFLICT (run_id, offset_days, kind) DO UPDATE SET due_on = EXCLUDED.due_on`,
        [runId, off, payDate, kind],
      );
    }
    const { rows } = await client.query(
      `SELECT id, offset_days, due_on, kind, status FROM payroll_reminders
        WHERE run_id = $1 ORDER BY due_on`, [runId],
    );
    return rows;
  });

export const dueReminders = async (tenant, onDate = null) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT rm.*, r.period_month, r.period_year, r.pay_date, r.status AS run_status,
            r.total_net, r.employee_count
       FROM payroll_reminders rm
       JOIN payroll_runs r ON r.id = rm.run_id
      WHERE rm.status = 'pending'
        AND rm.due_on <= COALESCE($1::date, current_date)
        AND r.status NOT IN ('cancelled','paid')
      ORDER BY rm.due_on`,
    [onDate],
  );
  return rows;
};

export const markReminderSent = (tenant, id, recipients) =>
  tenantQuery(
    tenant,
    `UPDATE payroll_reminders SET status = 'sent', sent_at = now(), recipients = $2 WHERE id = $1`,
    [id, JSON.stringify(recipients ?? [])],
  );

export const settings = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT pay_day_of_month, reminder_offsets, notify_on_complete FROM payroll_settings WHERE id = 1`,
  );
  return rows[0] ?? { pay_day_of_month: 1, reminder_offsets: [3, 1, 0], notify_on_complete: true };
};

export const saveSettings = async (tenant, patch, actorId) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE payroll_settings
        SET pay_day_of_month = COALESCE($1, pay_day_of_month),
            reminder_offsets = COALESCE($2::jsonb, reminder_offsets),
            notify_on_complete = COALESCE($3, notify_on_complete),
            updated_by = $4, updated_at = now()
      WHERE id = 1 RETURNING *`,
    [patch.pay_day_of_month ?? null,
      patch.reminder_offsets ? JSON.stringify(patch.reminder_offsets) : null,
      patch.notify_on_complete ?? null, actorId ?? null],
  );
  return rows[0];
};

// ---- salary access log ----------------------------------------------------
export const logAccess = (tenant, { actorId, subjectUserId, action, entityType, entityId }) =>
  tenantQuery(
    tenant,
    `INSERT INTO salary_access_log (actor_user_id, subject_user_id, action, entity_type, entity_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [actorId ?? null, subjectUserId ?? null, action, entityType ?? null, entityId ?? null],
  ).catch(() => null);   // never fail a read because the audit insert failed
