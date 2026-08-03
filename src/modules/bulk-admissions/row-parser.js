// Row parsing + validation for the historical-admission import sheet.
//
// Pure: no DB access, no side effects. Everything that needs the database
// (dropdown resolution, counsellor lookup, duplicate detection, UTR
// uniqueness) happens in the worker around this. Keeping the split here means
// the rules that actually decide whether a row is importable can be tested
// without a tenant, a queue, or a spreadsheet.
import { isBlank, normalizePhone, parseSheetDate, parseSheetNumber } from '../../lib/spreadsheet-values.js';
import {
  EMI_SLOTS, EDU_SLOTS, range,
  TRAINING_MODES, ADMISSION_STATUSES, PAYMENT_MODES, COLLECTION_MODES, GRADE_UNITS,
} from './columns.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
// Registration + Σ installments must equal course_fees to within this much.
// Same tolerance as lead-fee-offers/schema.js so the sheet and the in-app
// fee-offer form agree on what "balances" means.
export const FEE_EPSILON = 0.01;

const fail = (code, message) => ({ ok: false, error: { code, message } });
const trim = (v) => (isBlank(v) ? null : String(v).trim());
const lower = (v) => (isBlank(v) ? null : String(v).trim().toLowerCase());

// ---------------------------------------------------------------------------
// Row parsing / validation — pure, no DB access.
// ---------------------------------------------------------------------------
export const parseRow = (raw) => {
  const row = {};

  // ---- Identity ----
  row.first_name = trim(raw.first_name);
  row.middle_name = trim(raw.middle_name);
  row.last_name = trim(raw.last_name);
  if (!row.first_name) return fail('MISSING_IDENTITY', 'first_name is required');

  row.email = lower(raw.email);
  if (row.email && !EMAIL_RE.test(row.email)) {
    return fail('INVALID_EMAIL', `Email "${raw.email}" is not a valid email address`);
  }

  const wa = normalizePhone(raw.whatsapp_number);
  if (!isBlank(raw.whatsapp_number) && wa === null) {
    return fail('INVALID_PHONE', `whatsapp_number "${raw.whatsapp_number}" is not a valid phone number`);
  }
  row.whatsapp_number = wa || null;

  const alt = normalizePhone(raw.alternate_contact);
  if (!isBlank(raw.alternate_contact) && alt === null) {
    return fail('INVALID_PHONE', `alternate_contact "${raw.alternate_contact}" is not a valid phone number`);
  }
  row.alternate_contact = alt || null;

  if (!row.email && !row.whatsapp_number) {
    return fail('MISSING_CONTACT', 'At least one of email or whatsapp_number is required');
  }

  row.gender = trim(raw.gender);
  row.address = trim(raw.address);
  row.city = trim(raw.city);
  row.state = trim(raw.state);
  row.country = trim(raw.country);
  row.pincode = trim(raw.pincode);

  // ---- Ownership (resolved against the DB later) ----
  row.lead_owner_email = trim(raw.lead_owner_email);
  row.branch = trim(raw.branch);

  // ---- Programme ----
  const admissionDate = parseSheetDate(raw.admission_date);
  if (admissionDate === undefined) return fail('MISSING_ADMISSION_DATE', 'admission_date is required');
  if (admissionDate === null) {
    return fail('INVALID_DATE', `admission_date "${raw.admission_date}" is not a recognised date — use DD-MM-YYYY`);
  }
  row.admission_date = admissionDate;

  row.course = trim(raw.course); // resolver enforces presence + creates
  row.center = trim(raw.center);
  row.source = trim(raw.source);
  row.break_reason = trim(raw.break_reason);

  row.mode_of_training = trim(raw.mode_of_training);
  if (!row.mode_of_training) return fail('INVALID_TRAINING_MODE', 'mode_of_training is required');
  const matchedMode = TRAINING_MODES.find((m) => m.toLowerCase() === row.mode_of_training.toLowerCase());
  if (!matchedMode) {
    return fail('INVALID_TRAINING_MODE', `mode_of_training "${raw.mode_of_training}" must be one of ${TRAINING_MODES.join(' / ')}`);
  }
  row.mode_of_training = matchedMode;

  const status = lower(raw.status);
  if (!status) return fail('INVALID_STATUS', 'status is required');
  if (!ADMISSION_STATUSES.includes(status)) {
    return fail('INVALID_STATUS', `status "${raw.status}" must be one of ${ADMISSION_STATUSES.join(' / ')}`);
  }
  row.status = status;

  // ---- Education ----
  row.education = [];
  for (const n of range(EDU_SLOTS)) {
    const examination = trim(raw[`edu_${n}_examination`]);
    // The examination name is the anchor: without it there's nothing to call
    // the qualification, so the whole slot is treated as unfilled.
    if (!examination) continue;

    const year = parseSheetNumber(raw[`edu_${n}_year`]);
    if (year === null) return fail('INVALID_NUMBER', `edu_${n}_year "${raw[`edu_${n}_year`]}" is not a number`);
    if (year !== undefined && (year < 1900 || year > 2100)) {
      return fail('INVALID_YEAR', `edu_${n}_year "${year}" is outside 1900–2100`);
    }

    const gradeUnit = (lower(raw[`edu_${n}_grade_unit`]) || 'percent');
    if (!GRADE_UNITS.includes(gradeUnit)) {
      return fail('INVALID_GRADE_UNIT', `edu_${n}_grade_unit "${raw[`edu_${n}_grade_unit`]}" must be ${GRADE_UNITS.join(' or ')}`);
    }
    const grade = parseSheetNumber(raw[`edu_${n}_grade`]);
    if (grade === null) return fail('INVALID_NUMBER', `edu_${n}_grade "${raw[`edu_${n}_grade`]}" is not a number`);
    const cap = gradeUnit === 'cgpa' ? 10 : 100;
    if (grade !== undefined && (grade < 0 || grade > cap)) {
      return fail('INVALID_GRADE', `edu_${n}_grade "${grade}" must be between 0 and ${cap} for ${gradeUnit}`);
    }

    row.education.push({
      examination,
      stream: trim(raw[`edu_${n}_stream`]),
      college_name: trim(raw[`edu_${n}_college`]),
      board_university: trim(raw[`edu_${n}_board_university`]),
      year_of_passing: year ?? null,
      percentage: grade ?? null,
      grade_unit: gradeUnit,
    });
  }

  row.photo = trim(raw.photo);

  // ---- Money: headline ----
  const courseFees = parseSheetNumber(raw.course_fees);
  if (courseFees === undefined) return fail('MISSING_COURSE_FEES', 'course_fees is required');
  if (courseFees === null || courseFees < 0) {
    return fail('INVALID_NUMBER', `course_fees "${raw.course_fees}" is not a valid amount`);
  }
  row.course_fees = courseFees;

  const payMode = trim(raw.mode_of_payment);
  if (!payMode) return fail('INVALID_PAYMENT_MODE', 'mode_of_payment is required');
  const matchedPayMode = PAYMENT_MODES.find((m) => m.toLowerCase() === payMode.toLowerCase());
  if (!matchedPayMode) {
    return fail('INVALID_PAYMENT_MODE', `mode_of_payment "${raw.mode_of_payment}" must be ${PAYMENT_MODES.join(' or ')}`);
  }
  row.mode_of_payment = matchedPayMode;

  const collectionMode = lower(raw.collection_mode) || 'cash';
  if (!COLLECTION_MODES.includes(collectionMode)) {
    return fail('INVALID_COLLECTION_MODE', `collection_mode "${raw.collection_mode}" must be one of ${COLLECTION_MODES.join(' / ')}`);
  }
  row.collection_mode = collectionMode;
  row.payment_account = trim(raw.payment_account);

  // ---- Money: registration ----
  const regAmount = parseSheetNumber(raw.registration_amount);
  if (regAmount === null) return fail('INVALID_NUMBER', `registration_amount "${raw.registration_amount}" is not a number`);
  const regPaid = parseSheetNumber(raw.registration_paid_amount);
  if (regPaid === null) return fail('INVALID_NUMBER', `registration_paid_amount "${raw.registration_paid_amount}" is not a number`);
  const regDate = parseSheetDate(raw.registration_paid_date);
  if (regDate === null) return fail('INVALID_DATE', `registration_paid_date "${raw.registration_paid_date}" is not a recognised date — use DD-MM-YYYY`);

  row.registration = {
    amount: regAmount ?? 0,
    paid_amount: regPaid ?? 0,
    // A collection with no stated date is dated to the admission itself —
    // the only defensible guess, and it keeps the receipt inside the
    // student's own timeline rather than dating it to the import run.
    paid_date: regDate ?? row.admission_date,
    utr: trim(raw.registration_utr),
    proof_file_name: trim(raw.registration_proof),
  };
  if (row.registration.paid_amount < 0) {
    return fail('INVALID_NUMBER', 'registration_paid_amount cannot be negative');
  }
  if (row.registration.paid_amount > row.registration.amount + FEE_EPSILON) {
    return fail('PAID_EXCEEDS_DUE', `registration_paid_amount (${row.registration.paid_amount}) is more than registration_amount (${row.registration.amount})`);
  }

  // ---- Money: installments ----
  row.installments = [];
  let sawGap = false;
  for (const n of range(EMI_SLOTS)) {
    const dueDate = parseSheetDate(raw[`emi_${n}_due_date`]);
    if (dueDate === null) return fail('INVALID_DATE', `emi_${n}_due_date "${raw[`emi_${n}_due_date`]}" is not a recognised date — use DD-MM-YYYY`);
    const amount = parseSheetNumber(raw[`emi_${n}_amount`]);
    if (amount === null) return fail('INVALID_NUMBER', `emi_${n}_amount "${raw[`emi_${n}_amount`]}" is not a number`);

    const empty = dueDate === undefined && amount === undefined;
    if (empty) { sawGap = true; continue; }
    // A filled slot after an empty one almost always means a column got
    // shifted while pasting, which would silently renumber every later
    // installment. Cheaper to reject than to guess.
    if (sawGap) {
      return fail('EMI_GAP', `emi_${n}_* is filled but an earlier installment slot is empty — fill installments in order, without gaps`);
    }
    if (dueDate === undefined || amount === undefined) {
      return fail('EMI_INCOMPLETE', `installment ${n} needs both emi_${n}_due_date and emi_${n}_amount`);
    }
    if (amount < 0) return fail('INVALID_NUMBER', `emi_${n}_amount cannot be negative`);

    const paid = parseSheetNumber(raw[`emi_${n}_paid_amount`]);
    if (paid === null) return fail('INVALID_NUMBER', `emi_${n}_paid_amount "${raw[`emi_${n}_paid_amount`]}" is not a number`);
    if (paid !== undefined && paid < 0) return fail('INVALID_NUMBER', `emi_${n}_paid_amount cannot be negative`);
    if ((paid ?? 0) > amount + FEE_EPSILON) {
      return fail('PAID_EXCEEDS_DUE', `emi_${n}_paid_amount (${paid}) is more than emi_${n}_amount (${amount})`);
    }
    const paidDate = parseSheetDate(raw[`emi_${n}_paid_date`]);
    if (paidDate === null) return fail('INVALID_DATE', `emi_${n}_paid_date "${raw[`emi_${n}_paid_date`]}" is not a recognised date — use DD-MM-YYYY`);

    row.installments.push({
      installment_no: row.installments.length + 1,
      due_date: dueDate,
      amount,
      paid_amount: paid ?? 0,
      // Falls back to the due date: for a historical plan that's the closest
      // honest approximation of when the money arrived.
      paid_date: paidDate ?? dueDate,
      utr: trim(raw[`emi_${n}_utr`]),
      proof_file_name: trim(raw[`emi_${n}_proof`]),
    });
  }

  // ---- Cross-field money rules ----
  const installmentSum = row.installments.reduce((a, r) => a + r.amount, 0);
  if (row.mode_of_payment === 'Installment') {
    if (!row.installments.length) {
      return fail('FEE_MATH_MISMATCH', 'mode_of_payment is Installment but no emi_* columns are filled');
    }
    const total = row.registration.amount + installmentSum;
    if (Math.abs(total - row.course_fees) > FEE_EPSILON) {
      return fail(
        'FEE_MATH_MISMATCH',
        `registration_amount + installments (${total}) must equal course_fees (${row.course_fees})`,
      );
    }
  } else if (row.installments.length) {
    return fail('FEE_MATH_MISMATCH', 'mode_of_payment is Full — remove the emi_* columns, or switch to Installment');
  }

  row.total_paid = row.registration.paid_amount + row.installments.reduce((a, r) => a + r.paid_amount, 0);

  const paidTillDate = parseSheetNumber(raw.paid_till_date);
  if (paidTillDate === null) return fail('INVALID_NUMBER', `paid_till_date "${raw.paid_till_date}" is not a number`);
  if (paidTillDate !== undefined && Math.abs(paidTillDate - row.total_paid) > FEE_EPSILON) {
    return fail(
      'PAID_MISMATCH',
      `paid_till_date (${paidTillDate}) doesn't match the paid amounts on this row (${row.total_paid}). Fix one or clear paid_till_date.`,
    );
  }

  row.name = [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ');
  return { ok: true, row };
};

// Every UTR the row carries, tagged with the column it came from so the error
// message can point at the right cell.
export const utrsOf = (row) => {
  const out = [];
  if (row.registration.utr && row.registration.paid_amount > 0) {
    out.push({ column: 'registration_utr', value: row.registration.utr });
  }
  for (const inst of row.installments) {
    if (inst.utr && inst.paid_amount > 0) {
      out.push({ column: `emi_${inst.installment_no}_utr`, value: inst.utr });
    }
  }
  return out;
};

// Every attachment file name the row references.
export const attachmentsOf = (row) => {
  const out = [];
  if (row.photo) out.push({ column: 'photo', value: row.photo, code: 'PHOTO_NOT_FOUND' });
  if (row.registration.proof_file_name && row.registration.paid_amount > 0) {
    out.push({ column: 'registration_proof', value: row.registration.proof_file_name, code: 'PROOF_NOT_FOUND' });
  }
  for (const inst of row.installments) {
    if (inst.proof_file_name && inst.paid_amount > 0) {
      out.push({
        column: `emi_${inst.installment_no}_proof`,
        value: inst.proof_file_name,
        code: 'PROOF_NOT_FOUND',
      });
    }
  }
  return out;
};

