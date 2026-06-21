import { tenantQuery } from '../../db/tenant.js';

const COLS = `
  d.id, d.lead_id, d.discount_percent, d.status, d.reason, d.reject_reason,
  d.requested_by, d.approved_by, d.approved_at, d.created_at, d.updated_at,
  d.pending_stage_id, d.pending_sub_stage_id,
  ru.name AS requested_by_name, au.name AS approved_by_name
`;

const FROM = `
  FROM lead_discounts d
  LEFT JOIN users ru ON ru.id = d.requested_by
  LEFT JOIN users au ON au.id = d.approved_by
`;

export const findByLead = async (tenant, lead_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} ${FROM} WHERE d.lead_id = $1 LIMIT 1`,
    [lead_id],
  );
  return rows[0] ?? null;
};

export const findById = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} ${FROM} WHERE d.id = $1 LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
};

// Upsert the lead's current discount (one row per lead). The caller has
// already resolved the status (approved when within the counsellor cap,
// pending_approval otherwise) and approver fields. Returns the new row.
export const upsert = async (tenant, lead_id, { discount_percent, status, reason, requested_by, approved_by, approved_at, pending_stage_id, pending_sub_stage_id }) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO lead_discounts
       (lead_id, discount_percent, status, reason, requested_by, approved_by, approved_at, pending_stage_id, pending_sub_stage_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (lead_id) DO UPDATE
       SET discount_percent = EXCLUDED.discount_percent,
           status = EXCLUDED.status,
           reason = EXCLUDED.reason,
           requested_by = EXCLUDED.requested_by,
           approved_by = EXCLUDED.approved_by,
           approved_at = EXCLUDED.approved_at,
           pending_stage_id = EXCLUDED.pending_stage_id,
           pending_sub_stage_id = EXCLUDED.pending_sub_stage_id,
           -- clear any stale rejection note when the row is re-requested
           reject_reason = NULL
     RETURNING id`,
    [lead_id, discount_percent, status, reason ?? null, requested_by ?? null, approved_by ?? null, approved_at ?? null, pending_stage_id ?? null, pending_sub_stage_id ?? null],
  );
  return findById(tenant, rows[0].id);
};

// Transition a pending discount to approved / rejected. `discount_percent`
// lets the approver grant a different % than requested. Clears the held
// conversion stage once decided (the service performs the actual stage move).
export const decide = async (tenant, id, { status, approved_by, reject_reason, discount_percent }) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE lead_discounts
        SET status = $2,
            approved_by = $3,
            approved_at = now(),
            reject_reason = $4,
            discount_percent = COALESCE($5, discount_percent),
            pending_stage_id = NULL,
            pending_sub_stage_id = NULL
      WHERE id = $1
      RETURNING id`,
    [id, status, approved_by ?? null, reject_reason ?? null, discount_percent ?? null],
  );
  if (!rows[0]) return null;
  return findById(tenant, id);
};

// Pending-approval queue, scoped to a set of requester ids (a manager's team
// subtree). Pass null user_ids for the whole tenant (super_admin).
export const listPending = async (tenant, user_ids) => {
  const params = [];
  let scopeCond = '';
  if (Array.isArray(user_ids)) {
    params.push(user_ids);
    scopeCond = `AND d.requested_by = ANY($${params.length}::uuid[])`;
  }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS}, l.name AS lead_name, l.assigned_to
       ${FROM}
       JOIN leads l ON l.id = d.lead_id AND l.deleted_at IS NULL
      WHERE d.status = 'pending_approval' ${scopeCond}
      ORDER BY d.created_at ASC`,
    params,
  );
  return rows;
};
