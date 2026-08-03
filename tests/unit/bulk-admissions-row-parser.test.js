import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRow, utrsOf, attachmentsOf } from '../../src/modules/bulk-admissions/row-parser.js';

// A minimal row that passes. Individual tests override one field at a time so
// a failure names exactly one rule.
const base = () => ({
  first_name: 'Payal',
  last_name: 'Khatri',
  email: 'payal@example.test',
  whatsapp_number: '7821013136',
  admission_date: '20-07-2026',
  course: 'Data Analytics',
  mode_of_training: 'Offline',
  status: 'attending',
  course_fees: 25000,
  mode_of_payment: 'Installment',
  registration_amount: 2000,
  registration_paid_amount: 2000,
  registration_paid_date: '20-07-2026',
  emi_1_due_date: '25-07-2026',
  emi_1_amount: 8000,
  emi_1_paid_amount: 0,
  emi_2_due_date: '25-08-2026',
  emi_2_amount: 15000,
  emi_2_paid_amount: 0,
});

const ok = (over = {}) => {
  const r = parseRow({ ...base(), ...over });
  assert.ok(r.ok, `expected success, got ${r.error?.code}: ${r.error?.message}`);
  return r.row;
};
const err = (over) => {
  const r = parseRow({ ...base(), ...over });
  assert.equal(r.ok, false, 'expected this row to be rejected');
  return r.error.code;
};

test('a well-formed row parses', () => {
  const row = ok();
  assert.equal(row.name, 'Payal Khatri');
  assert.equal(row.whatsapp_number, '+917821013136');
  assert.equal(row.admission_date, '2026-07-20');
  assert.equal(row.installments.length, 2);
  assert.equal(row.total_paid, 2000);
});

// ---- identity / contact ----------------------------------------------------
test('first_name is required', () => {
  assert.equal(err({ first_name: '' }), 'MISSING_IDENTITY');
});

test('email or whatsapp is required, either alone is enough', () => {
  assert.equal(err({ email: '', whatsapp_number: '' }), 'MISSING_CONTACT');
  ok({ email: '' });
  ok({ whatsapp_number: '' });
});

test('email is lower-cased and format-checked', () => {
  assert.equal(ok({ email: '  Payal@Example.TEST ' }).email, 'payal@example.test');
  assert.equal(err({ email: 'not-an-email' }), 'INVALID_EMAIL');
});

test('a too-short phone is rejected rather than stored', () => {
  assert.equal(err({ whatsapp_number: '12345' }), 'INVALID_PHONE');
  assert.equal(err({ alternate_contact: '999' }), 'INVALID_PHONE');
});

// ---- programme -------------------------------------------------------------
test('admission_date is required and must parse', () => {
  assert.equal(err({ admission_date: '' }), 'MISSING_ADMISSION_DATE');
  assert.equal(err({ admission_date: 'last July' }), 'INVALID_DATE');
});

test('status and mode_of_training are matched case-insensitively', () => {
  assert.equal(ok({ status: 'ATTENDING' }).status, 'attending');
  assert.equal(ok({ status: 'on_break' }).status, 'on_break');
  assert.equal(ok({ mode_of_training: 'offline' }).mode_of_training, 'Offline');
  assert.equal(err({ status: 'enrolled' }), 'INVALID_STATUS');
  assert.equal(err({ mode_of_training: 'Remote' }), 'INVALID_TRAINING_MODE');
});

// ---- education -------------------------------------------------------------
test('an education slot without an examination name is skipped, not failed', () => {
  // The examination is the anchor; a stray college name in an otherwise empty
  // slot shouldn't create a nameless qualification.
  assert.equal(ok({ edu_1_college: 'SKN COE' }).education.length, 0);
  assert.equal(ok({ edu_1_examination: 'B.E.' }).education.length, 1);
});

test('grade is validated against its unit', () => {
  assert.equal(ok({ edu_1_examination: 'B.E.', edu_1_grade: 72 }).education[0].percentage, 72);
  assert.equal(ok({ edu_1_examination: 'B.E.', edu_1_grade: 8.4, edu_1_grade_unit: 'cgpa' }).education[0].percentage, 8.4);
  // 12 is a fine percentage but an impossible CGPA.
  assert.equal(err({ edu_1_examination: 'B.E.', edu_1_grade: 12, edu_1_grade_unit: 'cgpa' }), 'INVALID_GRADE');
  assert.equal(err({ edu_1_examination: 'B.E.', edu_1_grade: 120 }), 'INVALID_GRADE');
  assert.equal(err({ edu_1_examination: 'B.E.', edu_1_grade_unit: 'gpa' }), 'INVALID_GRADE_UNIT');
});

test('grade_unit defaults to percent', () => {
  assert.equal(ok({ edu_1_examination: 'HSC' }).education[0].grade_unit, 'percent');
});

// ---- money: the balance rule ----------------------------------------------
test('registration + installments must equal course_fees', () => {
  assert.equal(err({ course_fees: 30000 }), 'FEE_MATH_MISMATCH');
  assert.equal(err({ emi_2_amount: 14000 }), 'FEE_MATH_MISMATCH');
  // Within the epsilon, rounding is tolerated.
  ok({ course_fees: 25000.005 });
});

test('Installment mode needs at least one installment', () => {
  assert.equal(
    err({ emi_1_due_date: '', emi_1_amount: '', emi_2_due_date: '', emi_2_amount: '', registration_amount: 25000, registration_paid_amount: 0 }),
    'FEE_MATH_MISMATCH',
  );
});

test('Full mode must not carry installments', () => {
  assert.equal(err({ mode_of_payment: 'Full' }), 'FEE_MATH_MISMATCH');
  const row = ok({
    mode_of_payment: 'Full',
    emi_1_due_date: '', emi_1_amount: '', emi_1_paid_amount: '',
    emi_2_due_date: '', emi_2_amount: '', emi_2_paid_amount: '',
    registration_amount: 25000, registration_paid_amount: 25000,
  });
  assert.equal(row.installments.length, 0);
  assert.equal(row.total_paid, 25000);
});

// ---- money: partial / full / due -------------------------------------------
test('the three payment states each parse correctly', () => {
  // Fully paid registration + one paid installment.
  const full = ok({ registration_paid_amount: 2000, emi_1_paid_amount: 8000, emi_2_paid_amount: 15000 });
  assert.equal(full.total_paid, 25000);
  // Partly paid installment.
  const partial = ok({ emi_1_paid_amount: 3000 });
  assert.equal(partial.total_paid, 5000);
  assert.equal(partial.installments[0].paid_amount, 3000);
  // Nothing collected at all.
  const due = ok({ registration_paid_amount: 0 });
  assert.equal(due.total_paid, 0);
});

test('a paid amount can never exceed what was owed', () => {
  assert.equal(err({ registration_paid_amount: 5000 }), 'PAID_EXCEEDS_DUE');
  assert.equal(err({ emi_1_paid_amount: 9000 }), 'PAID_EXCEEDS_DUE');
});

test('paid dates fall back sensibly when the sheet omits them', () => {
  // Registration falls back to the admission date; an installment to its due
  // date. Both keep the receipt inside the student's own timeline rather than
  // dating it to whenever the import happened to run.
  const row = ok({ registration_paid_date: '', emi_1_paid_amount: 8000, emi_1_paid_date: '' });
  assert.equal(row.registration.paid_date, '2026-07-20');
  assert.equal(row.installments[0].paid_date, '2026-07-25');
});

// ---- money: installment slot integrity -------------------------------------
test('a gap between installment slots is rejected', () => {
  // emi_1 empty, emi_2 filled — nearly always a shifted paste, which would
  // silently renumber the plan.
  assert.equal(
    err({ emi_1_due_date: '', emi_1_amount: '', registration_amount: 10000 }),
    'EMI_GAP',
  );
});

test('an installment needs both a date and an amount', () => {
  assert.equal(err({ emi_2_amount: '' }), 'EMI_INCOMPLETE');
  assert.equal(err({ emi_2_due_date: '' }), 'EMI_INCOMPLETE');
});

test('installments are renumbered from 1 contiguously', () => {
  const row = ok();
  assert.deepEqual(row.installments.map((i) => i.installment_no), [1, 2]);
});

// ---- money: the reconciliation column --------------------------------------
test('paid_till_date cross-checks the individual paid amounts', () => {
  ok({ paid_till_date: 2000 });
  assert.equal(err({ paid_till_date: 5000 }), 'PAID_MISMATCH');
  // Blank means "don't check" — it must not be read as zero.
  ok({ paid_till_date: '' });
});

// ---- collection metadata ---------------------------------------------------
test('collection_mode defaults to cash and is validated', () => {
  assert.equal(ok().collection_mode, 'cash');
  assert.equal(ok({ collection_mode: 'UPI' }).collection_mode, 'upi');
  assert.equal(err({ collection_mode: 'bitcoin' }), 'INVALID_COLLECTION_MODE');
});

test('numbers survive export formatting', () => {
  const row = ok({ course_fees: '25,000', registration_amount: '₹2,000' });
  assert.equal(row.course_fees, 25000);
  assert.equal(row.registration.amount, 2000);
  assert.equal(err({ course_fees: 'twenty five thousand' }), 'INVALID_NUMBER');
});

// ---- UTR / attachment collection -------------------------------------------
test('utrsOf only reports UTRs attached to money actually collected', () => {
  // A UTR against an unpaid installment produces no receipt, so claiming the
  // reference would wrongly burn it for the payment that eventually arrives.
  const paid = ok({ registration_utr: 'UTR001', emi_1_paid_amount: 8000, emi_1_utr: 'UTR002' });
  assert.deepEqual(utrsOf(paid).map((u) => u.value), ['UTR001', 'UTR002']);

  const unpaid = ok({ registration_utr: 'UTR001', emi_1_utr: 'UTR002' }); // emi_1 unpaid
  assert.deepEqual(utrsOf(unpaid).map((u) => u.value), ['UTR001']);
});

test('attachmentsOf reports the photo plus proofs for collected payments', () => {
  const row = ok({
    photo: 'payal.jpg',
    registration_proof: 'reg.jpg',
    emi_1_paid_amount: 8000,
    emi_1_proof: 'emi1.jpg',
    emi_2_proof: 'emi2.jpg', // emi_2 is unpaid → no receipt → not required
  });
  assert.deepEqual(attachmentsOf(row).map((a) => a.value), ['payal.jpg', 'reg.jpg', 'emi1.jpg']);
  assert.equal(attachmentsOf(row)[0].code, 'PHOTO_NOT_FOUND');
  assert.equal(attachmentsOf(row)[1].code, 'PROOF_NOT_FOUND');
});
