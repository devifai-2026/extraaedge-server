// Single source of truth for the historical-admission import sheet.
//
// The template builder emits HEADERS in this exact order, and the worker
// reads rows back by these same keys — so a column can only ever be added
// or renamed in one place. (The lead template keeps its header list inside
// its builder; that one is stable and single-consumer. This sheet is read
// by a worker that fans one row into five tables, so the contract is worth
// hoisting out.)

// How many installment slots the sheet exposes.
//
// Four, because that's what the rest of the product supports: a fee plan is
// sold as at most four installments, lead_fee_offers.fee_installments is
// capped at 4 by its zod schema, and the Configure Fee Offer modal renders
// exactly four rows. A wider sheet would only invite operators to fill in a
// fifth that nothing downstream could show them.
//
// (admission_fee_schedule itself allows 1..20, so this is a product limit,
// not a storage one. If the business ever sells five, raise BOTH this and
// OFFER_MAX_INSTALLMENTS — and widen the Configure Fee Offer modal to match,
// or the extra installment becomes invisible there and is dropped on the
// next save. The test suite asserts these two stay in step.)
export const EMI_SLOTS = 4;

// The most installments lead_fee_offers can hold. Kept as its own constant
// rather than folded into EMI_SLOTS because it's a limit imposed by a
// different module — the worker still checks it before writing an offer, so
// raising EMI_SLOTS alone degrades gracefully instead of corrupting the
// offer UI.
export const OFFER_MAX_INSTALLMENTS = 4;

export const TRAINING_MODES = ['Online', 'Offline', 'Hybrid'];

// Mirrors the admissions_status_check constraint. 'rejected' is omitted on
// purpose — importing a pre-rejected admission has no meaning.
export const ADMISSION_STATUSES = [
  'attending', 'on_break', 'completed', 'dropped', 'pending_approval',
];

export const PAYMENT_MODES = ['Installment', 'Full'];

// Goes onto admission_receipts.mode_of_payment for every old-collection
// receipt the row produces. Free-form in the DB; we constrain the sheet so
// the Collection report groups cleanly.
export const COLLECTION_MODES = ['cash', 'online', 'upi', 'cheque', 'card'];

export const GRADE_UNITS = ['percent', 'cgpa'];

export const GENDERS = ['Male', 'Female', 'Other', 'Prefer not to say'];

// Education slots on the sheet. admission_education takes 1..N rows; two
// is enough for "highest qualification + the one before it".
export const EDU_SLOTS = 2;

const eduCols = (n) => [
  `edu_${n}_examination`, `edu_${n}_stream`, `edu_${n}_college`,
  `edu_${n}_board_university`, `edu_${n}_year`, `edu_${n}_grade`,
  `edu_${n}_grade_unit`,
];

// Six columns per installment: what's owed, what was collected, and the two
// pieces of evidence for that collection. utr goes into the uniquely-indexed
// admission_receipts.utr; proof takes an image the same three ways the
// student photo does (see ATTACHMENT_COLUMNS).
const emiCols = (n) => [
  `emi_${n}_due_date`, `emi_${n}_amount`, `emi_${n}_paid_amount`, `emi_${n}_paid_date`,
  `emi_${n}_utr`, `emi_${n}_proof`,
];

export const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

export const HEADERS = [
  // ---- Identity -----------------------------------------------------
  'first_name', 'middle_name', 'last_name',
  'email', 'whatsapp_number', 'alternate_contact',
  'gender', 'address', 'city', 'state', 'country', 'pincode',
  // ---- Ownership ----------------------------------------------------
  'lead_owner_email', 'branch',
  // ---- Programme ----------------------------------------------------
  'admission_date', 'course', 'mode_of_training', 'center',
  'status', 'break_reason', 'source',
  // ---- Education ----------------------------------------------------
  ...range(EDU_SLOTS).flatMap(eduCols),
  // ---- Photo --------------------------------------------------------
  'photo',
  // ---- Money: headline ----------------------------------------------
  'course_fees', 'mode_of_payment', 'collection_mode', 'payment_account',
  'registration_amount', 'registration_paid_amount', 'registration_paid_date',
  'registration_utr', 'registration_proof',
  // ---- Money: EMI plan ----------------------------------------------
  ...range(EMI_SLOTS).flatMap(emiCols),
  // ---- Reconciliation (optional) ------------------------------------
  'paid_till_date',
];

// Date columns, all parsed with the worker's IST-anchored parser.
export const DATE_COLUMNS = [
  'admission_date', 'registration_paid_date',
  ...range(EMI_SLOTS).flatMap((n) => [`emi_${n}_due_date`, `emi_${n}_paid_date`]),
];

// Numeric columns. Blank → undefined; non-numeric → row fails INVALID_NUMBER.
export const NUMERIC_COLUMNS = [
  'course_fees', 'registration_amount', 'registration_paid_amount', 'paid_till_date',
  ...range(EDU_SLOTS).flatMap((n) => [`edu_${n}_year`, `edu_${n}_grade`]),
  ...range(EMI_SLOTS).flatMap((n) => [`emi_${n}_amount`, `emi_${n}_paid_amount`]),
];

// Columns holding a UTR / bank reference. Each maps onto the uniquely-indexed
// admission_receipts.utr, so the worker also enforces uniqueness ACROSS the
// whole file — the realistic mistake is dragging one cell down a column,
// which the DB would only catch on the second row, after the first receipt
// was already written.
export const UTR_COLUMNS = [
  'registration_utr',
  ...range(EMI_SLOTS).map((n) => `emi_${n}_utr`),
];

// Columns that carry an image. Each accepts THREE forms, checked in this
// order, because operators arrive with whichever one their old system gave
// them and none of the three covers every case:
//
//   1. an image pasted directly into the cell — nothing to name, nothing to
//      keep in sync, and what people reach for on a small batch
//   2. an https link — what you get from Drive/Dropbox/any hosted store, and
//      the only option when the images live somewhere else entirely
//   3. a file name matched against files attached on the upload screen — the
//      workable path for hundreds of images, where embedding them all would
//      make the workbook itself unopenable
//
// `photo` lands on admissions.photo_r2_key; the rest on the matching
// receipt's payment_screenshot_r2_key.
export const ATTACHMENT_COLUMNS = [
  'photo',
  'registration_proof',
  ...range(EMI_SLOTS).map((n) => `emi_${n}_proof`),
];

// One example row so users see the expected shape (and date format) inline.
// Built positionally against HEADERS via a lookup so re-ordering HEADERS
// can't silently shift the example into the wrong columns.
//
// The image columns show a LINK rather than a file name on purpose. Whatever
// the example does is what gets copied down the sheet, and a bare file name
// teaches the one route that doesn't work on its own — it silently depends on
// remembering to attach that exact file on the upload screen. A link stands
// by itself.
const EXAMPLE = {
  first_name: 'Payal', middle_name: 'Rajkumar', last_name: 'Khatri',
  email: 'payal.khatri275@example.com',
  whatsapp_number: '7821013136', alternate_contact: '8087121385',
  gender: 'Female', address: '12 FC Road', city: 'Pune',
  state: 'Maharashtra', country: 'India', pincode: '411005',
  lead_owner_email: 'sakshi@yourinstitute.com', branch: '',
  admission_date: '20-07-2026', course: 'Data Analytics',
  mode_of_training: 'Offline', center: 'JM Road', status: 'attending',
  break_reason: '', source: 'Walk-in',
  edu_1_examination: 'B.E.', edu_1_stream: 'Computer', edu_1_college: 'SKN COE',
  edu_1_board_university: 'SPPU', edu_1_year: 2024, edu_1_grade: 72,
  edu_1_grade_unit: 'percent',
  photo: 'https://example.com/photos/payal-khatri.jpg',
  course_fees: 25000, mode_of_payment: 'Installment', collection_mode: 'upi',
  payment_account: 'HDFC Current',
  registration_amount: 2000, registration_paid_amount: 2000,
  registration_paid_date: '20-07-2026',
  registration_utr: '412345678901',
  registration_proof: 'https://example.com/proofs/payal-registration.jpg',
  emi_1_due_date: '25-07-2026', emi_1_amount: 8000, emi_1_paid_amount: 0,
  emi_1_paid_date: '', emi_1_utr: '', emi_1_proof: '',
  emi_2_due_date: '25-08-2026', emi_2_amount: 15000, emi_2_paid_amount: 0,
  emi_2_paid_date: '', emi_2_utr: '', emi_2_proof: '',
  paid_till_date: 2000,
};

export const EXAMPLE_ROW = HEADERS.map((h) => (EXAMPLE[h] === undefined ? '' : EXAMPLE[h]));
