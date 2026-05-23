import { z } from 'zod';

const blankToUndef = (v) => (v === '' ? undefined : v);
const optionalUuid = z.preprocess(blankToUndef, z.string().uuid().optional());

// Slim education row — same shape as the admin schema; the FE-side
// validation gives the student "Add another" if they want extra rows.
// grade_unit toggles the cap on `percentage` (100 vs 10) so CGPA can be
// captured without forcing students to convert to %.
const publicEducationRow = z.object({
  examination: z.string().min(1),
  stream: z.string().optional().nullable(),
  college_name: z.string().optional().nullable(),
  board_university: z.string().optional().nullable(),
  year_of_passing: z.coerce.number().int().min(1900).max(2100).optional().nullable(),
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

// Body the public form posts. Mirrors the admin admission form so the
// student fills the same shape; the accounts team can still edit later.
export const publicSubmitSchema = z.object({
  // Personal
  first_name: z.string().trim().min(1),
  middle_name: z.string().trim().optional().nullable(),
  last_name: z.string().trim().optional().nullable(),
  email: z.string().email().optional().or(z.literal('').transform(() => null)).nullable(),
  whatsapp_number: z.string().trim().min(7).max(20),
  alternate_contact: z.string().trim().optional().nullable(),
  address: z.string().trim().optional().nullable(),
  // Programme & schedule
  admission_date: z.coerce.date().optional(),
  program_id: optionalUuid,
  mode_of_training: z.string().optional(),
  center_id: optionalUuid,
  // Fees
  total_fees: z.coerce.number().nonnegative().optional(),
  mode_of_payment: z.string().optional().nullable(),
  // Photos (GCS keys returned by /public/admissions/:token/upload-confirm)
  selfie_r2_key: z.string().optional().nullable(),
  photo_r2_key:  z.string().optional().nullable(),
  // Education. At least one row with a real examination is required —
  // we can't usefully process an admission without qualification data,
  // and the public form gates on this client-side too. The check is on
  // the array shape because the row schema already enforces non-empty
  // examination per element.
  education: z.array(publicEducationRow)
    .min(1, { message: 'At least one qualification is required.' }),
});

export const tokenParam = z.object({ token: z.string().min(20).max(128) });

// Photo upload presign — image-only, 5 MB cap; the service enforces
// these too but the schema gives a clean 400 path.
export const publicPresignSchema = z.object({
  content_type: z.string().min(1),
  size_bytes: z.coerce.number().int().positive().max(5 * 1024 * 1024),
  filename: z.string().optional(),
});

export const publicConfirmSchema = z.object({
  r2_key: z.string().min(1),
});

export const publicSignedUrlQuery = z.object({
  r2_key: z.string().min(1),
});
