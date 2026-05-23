import { z } from 'zod';

// Empty-string → undefined so optional uuid fields don't 400.
const blankToUndef = (v) => (v === '' ? undefined : v);
const optionalUuid = z.preprocess(blankToUndef, z.string().uuid().optional());

const educationRow = z.object({
  examination: z.string().min(1),
  stream: z.string().optional().nullable(),
  college_name: z.string().optional().nullable(),
  board_university: z.string().optional().nullable(),
  year_of_passing: z.coerce.number().int().min(1900).max(2100).optional().nullable(),
  // Grade value lives in `percentage` regardless of the unit; the cap
  // is unit-aware (100 for %, 10 for CGPA). We accept 0–100 at the
  // base level and tighten via superRefine so a CGPA of 12.5 is rejected.
  percentage: z.coerce.number().min(0).max(100).optional().nullable(),
  grade_unit: z.enum(['percent', 'cgpa']).optional().default('percent'),
}).superRefine((row, ctx) => {
  if (row.percentage == null) return;
  const cap = row.grade_unit === 'cgpa' ? 10 : 100;
  if (row.percentage > cap) {
    ctx.addIssue({
      code: 'custom',
      path: ['percentage'],
      message: `Value must be ≤ ${cap} for ${row.grade_unit === 'cgpa' ? 'CGPA' : 'percent'}.`,
    });
  }
});

const feeInstallment = z.object({
  installment_no: z.coerce.number().int().min(1).max(20),
  due_date: z.coerce.date(),
  amount: z.coerce.number().nonnegative(),
});

// Statuses an admission can transition between via the API.
const STATUSES = ['pending_approval', 'attending', 'on_break', 'completed', 'rejected'];

export const createAdmissionSchema = z.object({
  // Optional link to a lead (auto-populated when the row came from a
  // converted lead). Manual admissions leave this null.
  lead_id: optionalUuid,
  admission_date: z.coerce.date(),
  // Identity
  first_name: z.string().min(1),
  middle_name: z.string().optional().nullable(),
  last_name: z.string().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('').transform(() => null)),
  whatsapp_number: z.string().min(7).max(20),
  alternate_contact: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  // Programme
  program_id: optionalUuid,
  mode_of_training: z.string().min(1),
  center_id: optionalUuid,
  // Money
  total_fees: z.coerce.number().nonnegative(),
  mode_of_payment: z.string().optional().nullable(),
  // Photos
  selfie_r2_key: z.string().optional().nullable(),
  photo_r2_key: z.string().optional().nullable(),
  // Provenance
  guided_by_counsellor_id: optionalUuid,
  guided_by_manager_id: optionalUuid,
  source: z.string().optional().nullable(),
  // Workflow
  status: z.enum(STATUSES).optional(),
  // Nested
  education: z.array(educationRow).optional(),
  fee_schedule: z.array(feeInstallment).optional(),
});

export const updateAdmissionSchema = createAdmissionSchema.partial();

export const listQuery = z.object({
  q: z.string().optional(),
  status: z.enum(STATUSES).optional(),
  program_id: z.string().uuid().optional(),
  center_id: z.string().uuid().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  // Convenience date scopes
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(), // "YYYY-MM"
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const reportQuery = z.object({
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  program_id: z.string().uuid().optional(),
});

export const idParam = z.object({ id: z.string().uuid() });

// Receipt creation. amount + mode_of_payment + receipt_date required.
// receipt_kind tags what the money pays for:
//   'installment'  → must also supply installment_no (1..N from the offer).
//   'registration' → one-time per admission (DB enforces uniqueness).
//   'misc'         → catch-all (default).
export const createReceiptSchema = z.object({
  receipt_no: z.string().optional(), // server auto-generates if absent
  receipt_date: z.coerce.date(),
  amount: z.coerce.number().positive(),
  mode_of_payment: z.string().min(1),
  transaction_details: z.string().optional().nullable(),
  is_old_collection: z.coerce.boolean().optional(),
  receipt_kind: z.enum(['installment', 'registration', 'misc']).optional().default('misc'),
  installment_no: z.coerce.number().int().min(1).max(20).optional().nullable(),
  // Optional GCS key for a payment screenshot the accounts user
  // attached when capturing the receipt (UPI / bank screenshot, etc.).
  // The FE uploads via /uploads/presign and posts the resulting r2_key.
  payment_screenshot_r2_key: z.string().optional().nullable(),
}).superRefine((data, ctx) => {
  // Cross-field rule: installment_no must be present iff
  // receipt_kind = 'installment'. Mirrors the FE picker which only shows
  // the slot dropdown when the kind is Installment.
  if (data.receipt_kind === 'installment' && data.installment_no == null) {
    ctx.addIssue({ code: 'custom', path: ['installment_no'], message: 'Pick which installment this receipt pays for.' });
  }
  if (data.receipt_kind !== 'installment' && data.installment_no != null) {
    ctx.addIssue({ code: 'custom', path: ['installment_no'], message: 'installment_no only applies when receipt_kind = installment.' });
  }
});

// Center CRUD (admin-only)
export const createCenterSchema = z.object({
  name: z.string().min(1),
  address: z.string().optional().nullable(),
  is_active: z.boolean().optional(),
  sort_order: z.coerce.number().int().optional(),
});
export const updateCenterSchema = createCenterSchema.partial();
