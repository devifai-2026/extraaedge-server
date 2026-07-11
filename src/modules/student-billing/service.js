// Student self-service billing — a student's own fee schedule, next EMI due,
// paid/balance totals, and their receipts (with the share_token the existing
// public-receipt page + PDF builder consume). Read-only; no online payment.
import * as repo from './repo.js';
import { buildScheduleWithStatus } from '../public-receipts/service.js';
import { notFound } from '../../lib/errors.js';

// The next unpaid installment (soonest future due first, else the earliest
// unpaid) — powers the "next EMI due" card.
const nextDue = (rows) => {
  const unpaid = rows.filter((r) => !r.paid && r.amount > 0);
  if (!unpaid.length) return null;
  const withDate = unpaid.filter((r) => r.due_date).sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  const pick = withDate[0] || unpaid[0];
  return { label: pick.label, amount: pick.amount, due_date: pick.due_date ?? null };
};

export const myPayments = async (tenant, studentId) => {
  const admissionId = await repo.studentAdmissionId(tenant, studentId);
  if (!admissionId) return { has_admission: false, fee_schedule: [], receipts: [], totals: { total: 0, paid: 0, due: 0 }, next_due: null };
  const [{ rows, totals }, receipts] = await Promise.all([
    buildScheduleWithStatus(tenant, admissionId),
    repo.receiptsForAdmission(tenant, admissionId),
  ]);
  return {
    has_admission: true,
    fee_schedule: rows,
    totals,
    next_due: nextDue(rows),
    receipts: receipts.map((r) => ({
      id: r.id,
      receipt_no: r.receipt_no,
      receipt_date: r.receipt_date,
      amount: Number(r.amount || 0),
      mode_of_payment: r.mode_of_payment,
      receipt_kind: r.receipt_kind,
      installment_no: r.installment_no,
      // Present ⇒ the FE can render/download the receipt via /public/receipts/:token.
      share_token: r.share_token ?? null,
    })),
  };
};

// Resolve a receipt's public share token, but only if it belongs to THIS
// student's admission — so the FE download can't reach another student's receipt.
export const myReceiptToken = async (tenant, studentId, receiptId) => {
  const admissionId = await repo.studentAdmissionId(tenant, studentId);
  if (!admissionId) throw notFound('No admission on record.');
  const token = await repo.receiptTokenForStudent(tenant, admissionId, receiptId);
  if (!token) throw notFound('Receipt not found.');
  return { share_token: token };
};
