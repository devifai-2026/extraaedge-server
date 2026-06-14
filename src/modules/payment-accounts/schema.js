import { z } from 'zod';

const blankToUndef = (v) => (v === '' || v === null ? undefined : v);
const optionalStr = z.preprocess(blankToUndef, z.string().trim().min(1).optional());

// IFSC: relaxed bank/branch code — 4 leading letters then alphanumerics,
// 6–15 chars total (case-insensitive). Accepts the official 11-char form
// (HDFC0001234 / SBIN0017760) as well as shorter co-op / legacy codes
// (e.g. SBIN17760). We intentionally do NOT force the reserved 0.
const ifsc = z.preprocess(blankToUndef, z.string().trim().regex(/^[A-Za-z]{4}[A-Za-z0-9]{2,11}$/, 'Invalid IFSC code').optional());
// UPI ID: relaxed. Ideally handle@psp (name@hdfcbank, 9877468277@idfc), but
// we also accept a looser alphanumeric handle (3–64 chars, may include
// . _ - @) so legacy/typed-in values aren't blocked. Length-bounded to avoid
// junk; the accounts team verifies the actual ID when collecting.
const upiId = z.preprocess(blankToUndef, z.string().trim().regex(/^[\w.@-]{3,64}$/, 'Invalid UPI ID').optional());

// One account row now carries up to THREE sections — Bank, UPI, QR — and is
// saved when at least one section is complete. All fields are independent.
const base = z.object({
  label: optionalStr,
  // Bank section
  account_holder_name: optionalStr,
  account_number: z.preprocess(blankToUndef, z.string().trim().regex(/^\d{6,20}$/, 'Account number must be 6–20 digits').optional()),
  ifsc,
  bank_name: optionalStr,
  branch: optionalStr,
  account_type: z.preprocess(blankToUndef, z.enum(['savings', 'current']).optional()),
  // UPI section
  upi_id: upiId,
  // QR section — GCS key of an uploaded QR image (from /uploads confirm).
  qr_r2_key: z.preprocess(blankToUndef, z.string().trim().optional()),
  // Multiple primaries are allowed; true marks this one primary (first
  // account is always primary regardless).
  is_primary: z.coerce.boolean().optional(),
  is_active: z.coerce.boolean().optional(),
});

// Section-completeness rules. A section is "complete" when:
//   • bank → holder name + account number + IFSC all present
//   • upi  → upi_id present
//   • qr   → qr_r2_key present
// To save: at least ONE section complete. A PARTIALLY-filled bank section
// (some-but-not-all of holder/acct/ifsc) is rejected so we never store a
// half-built bank record.
const bankComplete = (v) => Boolean(v.account_holder_name && v.account_number && v.ifsc);
const bankTouched = (v) => Boolean(v.account_holder_name || v.account_number || v.ifsc || v.bank_name || v.branch || v.account_type);
const upiComplete = (v) => Boolean(v.upi_id);
const qrComplete = (v) => Boolean(v.qr_r2_key);

const sectionRefine = (v, ctx) => {
  // Partial bank section → point at the missing required field(s).
  if (bankTouched(v) && !bankComplete(v)) {
    if (!v.account_holder_name) ctx.addIssue({ path: ['account_holder_name'], code: 'custom', message: 'Account holder name is required for the bank section' });
    if (!v.account_number) ctx.addIssue({ path: ['account_number'], code: 'custom', message: 'Account number is required for the bank section' });
    if (!v.ifsc) ctx.addIssue({ path: ['ifsc'], code: 'custom', message: 'IFSC is required for the bank section' });
  }
  // Need at least one complete section.
  if (!bankComplete(v) && !upiComplete(v) && !qrComplete(v)) {
    ctx.addIssue({ path: ['_'], code: 'custom', message: 'Fill at least one section completely: Bank (holder + account no + IFSC), UPI ID, or a QR image.' });
  }
};

export const createSchema = base.superRefine(sectionRefine);

// Update is a full replace of the editable fields — the FE always sends the
// whole form — so we apply the same section rules.
export const updateSchema = base.superRefine(sectionRefine);

export const idParam = z.object({ id: z.string().uuid() });

// Bulk set/unset primary on one or more accounts.
export const primaryBulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1, { message: 'Select at least one account.' }),
});

export const listQuery = z.object({
  q: z.string().trim().optional(),
  include_inactive: z.preprocess(
    (v) => (v === 'true' || v === true ? true : v === 'false' || v === false ? false : undefined),
    z.boolean().optional(),
  ),
});
