// Data access for staff leave. Raw SQL, tenant-scoped, no business rules —
// those live in service.js.
import { tenantQuery, tenantTx } from '../../db/tenant.js';

export const listTypes = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, code, name, is_paid, annual_quota_days, accrual, allow_half_day,
            carry_forward_max_days, requires_approval, color, order_index
       FROM leave_types WHERE deleted_at IS NULL AND is_active
      ORDER BY order_index, name`,
  );
  return rows;
};

export const findType = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT * FROM leave_types WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
};

const LEAVE_COLS = `
  l.id, l.user_id, l.leave_type_id, l.from_date, l.to_date, l.day_count,
  l.half_day, l.reason, l.status, l.decision_note, l.applied_via,
  l.attachment_r2_key, l.decided_at, l.cancelled_at, l.created_at,
  u.name AS user_name, u.email AS user_email, u.role AS user_role,
  t.code AS type_code, t.name AS type_name, t.is_paid
`;

export const findLeave = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${LEAVE_COLS}
       FROM staff_leave l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN leave_types t ON t.id = l.leave_type_id
      WHERE l.id = $1 AND l.deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
};

// `userIds = null` means unrestricted (admin/HR); an array scopes to a team.
export const listLeaves = async (tenant, { userIds, status, from, to, limit = 200 }) => {
  const conds = ['l.deleted_at IS NULL'];
  const params = [];
  if (userIds) { params.push(userIds); conds.push(`l.user_id = ANY($${params.length}::uuid[])`); }
  if (status) { params.push(status); conds.push(`l.status = $${params.length}`); }
  // Overlap, not containment: a leave spanning the window edge still counts.
  if (from) { params.push(from); conds.push(`l.to_date >= $${params.length}::date`); }
  if (to) { params.push(to); conds.push(`l.from_date <= $${params.length}::date`); }
  params.push(limit);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${LEAVE_COLS}
       FROM staff_leave l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN leave_types t ON t.id = l.leave_type_id
      WHERE ${conds.join(' AND ')}
      ORDER BY l.from_date DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
};

// Overlapping requests that are still live — used to reject a double booking.
export const overlapping = async (tenant, userId, from, to, excludeId = null) => {
  const params = [userId, from, to];
  let extra = '';
  if (excludeId) { params.push(excludeId); extra = `AND id <> $${params.length}`; }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, from_date, to_date, status FROM staff_leave
      WHERE user_id = $1 AND deleted_at IS NULL
        AND status IN ('pending','approved')
        AND from_date <= $3::date AND to_date >= $2::date ${extra}`,
    params,
  );
  return rows;
};

export const insertLeave = (tenant, input, client) => {
  const q = client
    ? (text, params) => client.query(text, params)
    : (text, params) => tenantQuery(tenant, text, params);
  return q(
    `INSERT INTO staff_leave
       (user_id, leave_type_id, from_date, to_date, day_count, half_day, reason,
        attachment_r2_key, applied_via, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [input.user_id, input.leave_type_id, input.from_date, input.to_date,
      input.day_count, input.half_day ?? null, input.reason ?? null,
      input.attachment_r2_key ?? null, input.applied_via ?? 'self',
      input.status ?? 'pending', input.created_by ?? null],
  ).then((r) => r.rows[0]);
};

export const insertApprovalSteps = async (tenant, leaveId, steps, client) => {
  const q = client
    ? (text, params) => client.query(text, params)
    : (text, params) => tenantQuery(tenant, text, params);
  for (let i = 0; i < steps.length; i += 1) {
    const st = steps[i];
    // eslint-disable-next-line no-await-in-loop
    await q(
      `INSERT INTO leave_approvals (leave_id, step_index, approver_role, approver_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT (leave_id, step_index) DO NOTHING`,
      [leaveId, i, st.approver_role ?? null, st.approver_id ?? null],
    );
  }
};

export const approvalSteps = async (tenant, leaveId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT a.id, a.step_index, a.approver_role, a.approver_id, a.status,
            a.decided_at, a.note, u.name AS approver_name
       FROM leave_approvals a
       LEFT JOIN users u ON u.id = a.approver_id
      WHERE a.leave_id = $1
      ORDER BY a.step_index`,
    [leaveId],
  );
  return rows;
};

// Steps awaiting THIS approver, across every request.
export const pendingFor = async (tenant, approverId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT a.id AS approval_id, a.step_index, l.id AS leave_id, l.from_date, l.to_date,
            l.day_count, l.reason, l.status AS leave_status,
            u.name AS user_name, u.role AS user_role, t.code AS type_code, t.name AS type_name
       FROM leave_approvals a
       JOIN staff_leave l ON l.id = a.leave_id AND l.deleted_at IS NULL
       JOIN users u ON u.id = l.user_id
       LEFT JOIN leave_types t ON t.id = l.leave_type_id
      WHERE a.approver_id = $1 AND a.status = 'pending' AND l.status = 'pending'
      ORDER BY l.from_date`,
    [approverId],
  );
  return rows;
};

export const policyFor = async (tenant, roleScope) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT approval_mode FROM leave_approval_policies WHERE role_scope = $1`,
    [roleScope],
  );
  return rows[0]?.approval_mode ?? 'lead_only';
};

export const listPolicies = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT role_scope, approval_mode FROM leave_approval_policies ORDER BY role_scope`,
  );
  return rows;
};

export const setPolicy = async (tenant, roleScope, mode) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO leave_approval_policies (role_scope, approval_mode)
     VALUES ($1,$2)
     ON CONFLICT (role_scope) DO UPDATE SET approval_mode = EXCLUDED.approval_mode, updated_at = now()
     RETURNING role_scope, approval_mode`,
    [roleScope, mode],
  );
  return rows[0];
};

export const decideStep = (tenant, approvalId, status, note, client) => {
  const q = client
    ? (text, params) => client.query(text, params)
    : (text, params) => tenantQuery(tenant, text, params);
  return q(
    `UPDATE leave_approvals SET status = $2, note = $3, decided_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [approvalId, status, note ?? null],
  ).then((r) => r.rows[0]);
};

export const setLeaveStatus = (tenant, id, status, note, client) => {
  const q = client
    ? (text, params) => client.query(text, params)
    : (text, params) => tenantQuery(tenant, text, params);
  return q(
    `UPDATE staff_leave
        SET status = $2, decision_note = COALESCE($3, decision_note),
            decided_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, status, note ?? null],
  ).then((r) => r.rows[0]);
};

export const cancelLeave = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE staff_leave SET status = 'cancelled', cancelled_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
};

// ---- balances ------------------------------------------------------------
export const balancesFor = async (tenant, userId, year) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT t.id AS leave_type_id, t.code, t.name, t.is_paid, t.annual_quota_days,
            COALESCE(b.opening_days, 0)         AS opening_days,
            COALESCE(b.accrued_days, t.annual_quota_days) AS accrued_days,
            COALESCE(b.used_days, 0)            AS used_days,
            COALESCE(b.carried_forward_days, 0) AS carried_forward_days,
            -- Pending requests are held against the balance so somebody cannot
            -- book the same days twice while the first is still awaiting a
            -- decision.
            COALESCE((
              SELECT SUM(l.day_count) FROM staff_leave l
               WHERE l.user_id = $1 AND l.leave_type_id = t.id
                 AND l.deleted_at IS NULL AND l.status = 'pending'
                 AND EXTRACT(YEAR FROM l.from_date) = $2
            ), 0) AS pending_days
       FROM leave_types t
       LEFT JOIN leave_balances b
              ON b.leave_type_id = t.id AND b.user_id = $1 AND b.period_year = $2
      WHERE t.deleted_at IS NULL AND t.is_active
      ORDER BY t.order_index, t.name`,
    [userId, year],
  );
  return rows.map((r) => ({
    ...r,
    available_days: Number(r.accrued_days) + Number(r.opening_days)
      + Number(r.carried_forward_days) - Number(r.used_days) - Number(r.pending_days),
  }));
};

// Move `delta` onto the balance and record WHY, in one transaction so a
// balance can never drift from its ledger.
export const adjustBalance = async (tenant, { userId, leaveTypeId, year, delta, reason, leaveId, actorId, note }) =>
  tenantTx(tenant, async (client) => {
    // accrued_days is SEEDED FROM THE TYPE'S QUOTA on first touch. It defaults
    // to 0 in the schema, and balancesFor reads COALESCE(b.accrued_days, quota)
    // — so once a row exists, a literal 0 wins over the fallback and the whole
    // entitlement silently vanishes (a 12-day quota read as -3 after taking 3).
    // Creating the row with the real entitlement is what keeps the projection
    // and the ledger agreeing.
    const { rows: [bal] } = await client.query(
      `INSERT INTO leave_balances (user_id, leave_type_id, period_year, used_days, accrued_days)
       VALUES ($1,$2,$3,0,
               COALESCE((SELECT annual_quota_days FROM leave_types WHERE id = $2), 0))
       ON CONFLICT (user_id, leave_type_id, period_year) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [userId, leaveTypeId, year],
    );
    await client.query(
      `UPDATE leave_balances SET used_days = used_days + $2, updated_at = now() WHERE id = $1`,
      [bal.id, delta],
    );
    await client.query(
      `INSERT INTO leave_ledger (balance_id, delta_days, reason, leave_id, actor_id, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [bal.id, delta, reason, leaveId ?? null, actorId ?? null, note ?? null],
    );
    return bal.id;
  });

// ---- holidays ------------------------------------------------------------
export const listHolidays = async (tenant, { from, to, branchId }) => {
  const conds = ['deleted_at IS NULL'];
  const params = [];
  if (from) { params.push(from); conds.push(`date >= $${params.length}::date`); }
  if (to) { params.push(to); conds.push(`date <= $${params.length}::date`); }
  // A NULL branch_id is org-wide, so it applies to everybody.
  if (branchId) { params.push(branchId); conds.push(`(branch_id IS NULL OR branch_id = $${params.length})`); }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, name, date, is_full_day, is_optional, branch_id
       FROM holidays WHERE ${conds.join(' AND ')} ORDER BY date`,
    params,
  );
  return rows;
};

export const insertHoliday = async (tenant, { name, date, branchId, isOptional, actorId }) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO holidays (name, date, branch_id, is_optional, is_full_day, created_by)
     VALUES ($1,$2,$3,$4,true,$5)
     ON CONFLICT DO NOTHING
     RETURNING id, name, date, branch_id, is_optional`,
    [name, date, branchId ?? null, isOptional ?? false, actorId ?? null],
  );
  return rows[0] ?? null;
};

export const deleteHoliday = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE holidays SET deleted_at = now() WHERE id = $1`, [id]);
};

// Users on APPROVED leave on a given date — the predicate auto-assignment uses.
export const userIdsOnLeave = async (tenant, onDate) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT DISTINCT user_id FROM staff_leave
      WHERE deleted_at IS NULL AND status = 'approved'
        AND $1::date BETWEEN from_date AND to_date`,
    [onDate],
  );
  return rows.map((r) => r.user_id);
};
