import { z } from 'zod';

// Optional fee-structure block on each program.
//
// Math rule: registration_amount + Σ fee_installments.amount === course_fees
// when payment_mode === 'installment'. For payment_mode === 'full' the
// installments array is ignored. We surface a single message in the
// refine() below so the FE can show it on the Save action.
//
// Floats are added with a small epsilon because we accept user-typed
// decimals (e.g. 33333.33). 1 paisa tolerance is plenty.
const feeInstallmentRow = z.object({
  installment_no: z.coerce.number().int().min(1).max(4),
  amount: z.coerce.number().nonnegative(),
});

const FEE_EPSILON = 0.01;

const baseProgramSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  description: z.string().optional(),
  category: z.enum(['abroad', 'domestic', 'coaching']).optional(),
  type: z.enum(['online', 'offline', 'hybrid']).optional(),
  price: z.coerce.number().nonnegative().optional(),
  currency: z.string().optional(),
  discount_price: z.coerce.number().nonnegative().optional(),
  duration_value: z.coerce.number().int().nonnegative().optional(),
  duration_unit: z.enum(['days', 'months', 'years']).optional(),
  eligibility: z.string().optional(),
  intake_month: z.string().optional(),
  country: z.string().optional(),
  is_active: z.boolean().optional(),
  is_featured: z.boolean().optional(),
  brochure_url: z.string().url().optional(),
  image_url: z.string().url().optional(),
  // ---- Fee structure (new) ----
  // course_fees is the canonical "total owed" number. May be null when
  // an existing course hasn't been re-saved yet — that's intentional.
  course_fees: z.coerce.number().nonnegative().nullable().optional(),
  registration_amount: z.coerce.number().nonnegative().nullable().optional(),
  payment_mode: z.enum(['full', 'installment']).nullable().optional(),
  // Up to 4 installment rows. Service layer is what enforces both
  // (a) cap of 4 and (b) sum === course_fees - registration_amount.
  fee_installments: z.array(feeInstallmentRow).max(4).nullable().optional(),
});

// Refine for the fee math. Applied on both create and update so an
// admin can't sneak inconsistent installments through PUT either.
const refineFees = (data, ctx) => {
  // Skip when the admin hasn't touched fees yet (legacy / brand-new row).
  if (data.payment_mode == null && data.course_fees == null) return;

  if (data.payment_mode === 'installment') {
    if (data.course_fees == null) {
      ctx.addIssue({ code: 'custom', path: ['course_fees'], message: 'Course fees is required when payment mode is Installment.' });
      return;
    }
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
    // No installments allowed when full payment.
    if (Array.isArray(data.fee_installments) && data.fee_installments.length) {
      ctx.addIssue({ code: 'custom', path: ['fee_installments'], message: 'Remove installments — payment mode is Full.' });
    }
  }
};

export const createProgramSchema = baseProgramSchema.superRefine(refineFees);
export const updateProgramSchema = baseProgramSchema.partial().superRefine(refineFees);

export const listQuery = z.object({
  q: z.string().optional(),
  category: z.enum(['abroad', 'domestic', 'coaching']).optional(),
  is_active: z.enum(['true', 'false']).optional(),
  is_featured: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const idParam = z.object({ id: z.string().uuid() });
