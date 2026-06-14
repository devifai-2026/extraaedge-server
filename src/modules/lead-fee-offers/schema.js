import { z } from 'zod';

// One offer installment = amount + due_date. The accounts team picks
// both when configuring the offer; the program-level defaults only
// know the amount, so due_date is required at the offer layer.
//
// `due_date` is coerced to a Date by zod and serialised back as a
// date-only string in repo writes. We accept ISO strings or YYYY-MM-DD
// from the FE (HTML <input type="date">).
const installmentRow = z.object({
  installment_no: z.coerce.number().int().min(1).max(4),
  amount: z.coerce.number().nonnegative(),
  due_date: z.coerce.date(),
});

const FEE_EPSILON = 0.01;

const baseShape = z.object({
  program_id: z.string().uuid(),
  course_fees: z.coerce.number().nonnegative(),
  registration_amount: z.coerce.number().nonnegative().default(0),
  // The date the registration was paid (or will be paid). Optional so an
  // accounts user can save an in-progress offer; the FE may want to
  // require it as a UX rule.
  registration_date: z.coerce.date().nullable().optional(),
  // Mode of training the accounts manager confirmed for this student.
  // Pre-fills the public admission form and is shown locked there so
  // the student can't accidentally change what was agreed. Nullable so
  // legacy offers (configured before this column existed) keep working.
  mode_of_training: z.enum(['Online', 'Offline', 'Hybrid']).nullable().optional(),
  payment_mode: z.enum(['full', 'installment']),
  fee_installments: z.array(installmentRow).max(4).nullable().optional(),
  // The bank/UPI account the student should pay the registration amount
  // into. Bound here so the public share-link reuses it without re-picking.
  payment_account_id: z.string().uuid().nullable().optional(),
  // Explicit amount the student must pay now into that account. When unset,
  // the public form falls back to the registration amount.
  pay_now_amount: z.coerce.number().nonnegative().nullable().optional(),
});

// Math rule: registration + Σ installments === course_fees when
// payment_mode='installment'. Service layer re-runs this on every
// mutation; we surface the same error on the schema so a curl bypassing
// the FE doesn't store a broken plan either.
const refineMath = (data, ctx) => {
  if (data.payment_mode === 'installment') {
    const installments = Array.isArray(data.fee_installments) ? data.fee_installments : [];
    if (!installments.length) {
      ctx.addIssue({ code: 'custom', path: ['fee_installments'], message: 'Add at least one installment row.' });
      return;
    }
    const reg = Number(data.registration_amount || 0);
    const sum = installments.reduce((acc, r) => acc + Number(r.amount || 0), 0);
    const total = reg + sum;
    if (Math.abs(total - Number(data.course_fees)) > FEE_EPSILON) {
      ctx.addIssue({
        code: 'custom',
        path: ['fee_installments'],
        message: `Registration + installments (${total.toFixed(2)}) must equal course fees (${Number(data.course_fees).toFixed(2)}).`,
      });
    }
  } else if (data.payment_mode === 'full') {
    if (Array.isArray(data.fee_installments) && data.fee_installments.length) {
      ctx.addIssue({ code: 'custom', path: ['fee_installments'], message: 'Remove installments — payment mode is Full.' });
    }
  }
};

export const upsertOfferSchema = baseShape.superRefine(refineMath);
export const leadIdParam = z.object({ leadId: z.string().uuid() });
