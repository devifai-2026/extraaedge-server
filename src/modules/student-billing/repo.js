import { tenantQuery } from '../../db/tenant.js';

// The admission a student is tied to (their fee record lives on the admission).
export const studentAdmissionId = async (tenant, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT admission_id FROM students WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [studentId],
  );
  return rows[0]?.admission_id ?? null;
};

// Receipts for the student's admission, newest first, with the share_token the
// public-receipt page + PDF builder use.
export const receiptsForAdmission = async (tenant, admissionId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, receipt_no, receipt_date, amount, mode_of_payment, receipt_kind,
            installment_no, share_token, created_at
       FROM admission_receipts
      WHERE admission_id = $1 AND deleted_at IS NULL
      ORDER BY receipt_date DESC NULLS LAST, created_at DESC`,
    [admissionId],
  );
  return rows;
};

// The share_token for one receipt, scoped to the student's admission (so a
// student can only resolve their OWN receipts).
export const receiptTokenForStudent = async (tenant, admissionId, receiptId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT share_token FROM admission_receipts
      WHERE id = $1 AND admission_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [receiptId, admissionId],
  );
  return rows[0]?.share_token ?? null;
};
