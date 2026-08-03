// Single source of truth for the historical-admission import sheet.
//
// The template builder emits HEADERS in this exact order, and the worker
// reads rows back by these same keys — so a column can only ever be added
// or renamed in one place. (The lead template keeps its header list inside
// its builder; that one is stable and single-consumer. This sheet is read
// by a worker that fans one row into five tables, so the contract is worth
// hoisting out.)

// How many installment slots the sheet exposes. admission_fee_schedule
// allows 1..20, but 8 covers every real historical plan we've seen and
// keeps the sheet under ~90 columns. Bumping this number is all that's
// needed to widen the template — builder and worker both read it.
export const EMI_SLOTS = 8;

// Above this count we skip the lead_fee_offers row (see OFFER_MAX_INSTALLMENTS
// use in the worker). lead_fee_offers.fee_installments is capped at 4 by zod
// and the Configure Fee Offer modal renders exactly 4 slots, so writing a
// 5th would be invisible in that UI and silently dropped on the next save.
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
// admission_receipts.utr; proof_file_name is matched against the images
// attached on the upload screen, same mechanism as the student photo.
const emiCols = (n) => [
  `emi_${n}_due_date`, `emi_${n}_amount`, `emi_${n}_paid_amount`, `emi_${n}_paid_date`,
  `emi_${n}_utr`, `emi_${n}_proof_file_name`,
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
  'photo_file_name',
  // ---- Money: headline ----------------------------------------------
  'course_fees', 'mode_of_payment', 'collection_mode', 'payment_account',
  'registration_amount', 'registration_paid_amount', 'registration_paid_date',
  'registration_utr', 'registration_proof_file_name',
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

// Columns holding the file name of an image attached on the upload screen.
// photo_file_name lands on admissions.photo_r2_key; the rest land on the
// matching receipt's payment_screenshot_r2_key.
export const ATTACHMENT_COLUMNS = [
  'photo_file_name',
  'registration_proof_file_name',
  ...range(EMI_SLOTS).map((n) => `emi_${n}_proof_file_name`),
];

// One example row so users see the expected shape (and date format) inline.
// Built positionally against HEADERS via a lookup so re-ordering HEADERS
// can't silently shift the example into the wrong columns.
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
  photo_file_name: 'payal-khatri.jpg',
  course_fees: 25000, mode_of_payment: 'Installment', collection_mode: 'upi',
  payment_account: 'HDFC Current',
  registration_amount: 2000, registration_paid_amount: 2000,
  registration_paid_date: '20-07-2026',
  registration_utr: '412345678901', registration_proof_file_name: 'payal-reg.jpg',
  emi_1_due_date: '25-07-2026', emi_1_amount: 8000, emi_1_paid_amount: 0,
  emi_1_paid_date: '', emi_1_utr: '', emi_1_proof_file_name: '',
  emi_2_due_date: '25-08-2026', emi_2_amount: 15000, emi_2_paid_amount: 0,
  emi_2_paid_date: '', emi_2_utr: '', emi_2_proof_file_name: '',
  paid_till_date: 2000,
};

export const EXAMPLE_ROW = HEADERS.map((h) => (EXAMPLE[h] === undefined ? '' : EXAMPLE[h]));
