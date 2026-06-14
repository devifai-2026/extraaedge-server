import { tenantQuery } from '../../db/tenant.js';

const COLS = `
  id, lead_id, program_id, course_fees, registration_amount, registration_date,
  mode_of_training, payment_mode, fee_installments, payment_account_id, pay_now_amount,
  created_by, updated_by, created_at, updated_at
`;

export const findByLead = async (tenant, lead_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM lead_fee_offers WHERE lead_id = $1 LIMIT 1`,
    [lead_id],
  );
  return rows[0] ?? null;
};

// Upsert with explicit conflict on lead_id (UNIQUE). Returns the new row.
// `actorId` lands in created_by on insert and updated_by on update.
export const upsert = async (tenant, lead_id, input, actorId) => {
  const installments = Array.isArray(input.fee_installments) ? input.fee_installments : null;
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO lead_fee_offers
       (lead_id, program_id, course_fees, registration_amount, registration_date,
        mode_of_training, payment_mode, fee_installments, payment_account_id, pay_now_amount, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $11)
     ON CONFLICT (lead_id) DO UPDATE
       SET program_id = EXCLUDED.program_id,
           course_fees = EXCLUDED.course_fees,
           registration_amount = EXCLUDED.registration_amount,
           registration_date = EXCLUDED.registration_date,
           mode_of_training = EXCLUDED.mode_of_training,
           payment_mode = EXCLUDED.payment_mode,
           fee_installments = EXCLUDED.fee_installments,
           payment_account_id = EXCLUDED.payment_account_id,
           pay_now_amount = EXCLUDED.pay_now_amount,
           updated_by = EXCLUDED.updated_by
     RETURNING ${COLS}`,
    [
      lead_id,
      input.program_id,
      input.course_fees,
      input.registration_amount ?? 0,
      input.registration_date ?? null,
      input.mode_of_training ?? null,
      input.payment_mode,
      installments != null ? JSON.stringify(installments) : null,
      input.payment_account_id ?? null,
      input.pay_now_amount ?? null,
      actorId ?? null,
    ],
  );
  return rows[0];
};
