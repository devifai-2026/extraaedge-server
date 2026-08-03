import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildTemplateXlsx } from '../../src/modules/bulk-admissions/template-builder.js';
import {
  HEADERS, EMI_SLOTS, EDU_SLOTS, UTR_COLUMNS, ATTACHMENT_COLUMNS,
  DATE_COLUMNS, NUMERIC_COLUMNS, EXAMPLE_ROW,
} from '../../src/modules/bulk-admissions/columns.js';

const LOOKUPS = {
  counsellors: [
    { name: 'Sakshi Wagh', email: 'sakshi@example.test' },
    { name: 'Divya N', email: 'divya@example.test' },
  ],
  courses: ['Data Analytics', 'Data Science', 'Python Full Stack'],
  centers: ['JM Road'],
  branches: ['Pune'],
  paymentAccounts: ['HDFC Current', 'office@upi'],
};

const load = async () => {
  const buf = await buildTemplateXlsx(LOOKUPS);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(buf));
  return wb;
};

test('columns: HEADERS has no duplicates', () => {
  assert.equal(new Set(HEADERS).size, HEADERS.length);
});

test('columns: every declared special column exists in HEADERS', () => {
  // These lists drive the worker's parsing. A column named in one of them but
  // missing from HEADERS would be silently ignored on every import.
  for (const list of [DATE_COLUMNS, NUMERIC_COLUMNS, UTR_COLUMNS, ATTACHMENT_COLUMNS]) {
    for (const col of list) {
      assert.ok(HEADERS.includes(col), `${col} is declared but not in HEADERS`);
    }
  }
});

test('columns: every EMI and education slot is fully represented', () => {
  for (let n = 1; n <= EMI_SLOTS; n += 1) {
    for (const suffix of ['due_date', 'amount', 'paid_amount', 'paid_date', 'utr', 'proof']) {
      assert.ok(HEADERS.includes(`emi_${n}_${suffix}`), `missing emi_${n}_${suffix}`);
    }
  }
  for (let n = 1; n <= EDU_SLOTS; n += 1) {
    for (const suffix of ['examination', 'stream', 'college', 'board_university', 'year', 'grade', 'grade_unit']) {
      assert.ok(HEADERS.includes(`edu_${n}_${suffix}`), `missing edu_${n}_${suffix}`);
    }
  }
});

test('columns: the example row lines up with HEADERS', () => {
  assert.equal(EXAMPLE_ROW.length, HEADERS.length);
  // Sanity-check a couple of positions so a reordering of HEADERS that
  // shifted the example into the wrong columns gets caught.
  assert.equal(EXAMPLE_ROW[HEADERS.indexOf('course')], 'Data Analytics');
  assert.equal(EXAMPLE_ROW[HEADERS.indexOf('course_fees')], 25000);
  assert.equal(EXAMPLE_ROW[HEADERS.indexOf('status')], 'attending');
});

test('columns: the example row balances under the fee-math rule', () => {
  // registration + Σ installments must equal course_fees, or the very first
  // thing an operator does — copy the example row — fails validation.
  const at = (name) => Number(EXAMPLE_ROW[HEADERS.indexOf(name)] || 0);
  let sum = at('registration_amount');
  for (let n = 1; n <= EMI_SLOTS; n += 1) sum += at(`emi_${n}_amount`);
  assert.equal(sum, at('course_fees'));
  // …and paid_till_date must agree with the paid amounts, same reason.
  let paid = at('registration_paid_amount');
  for (let n = 1; n <= EMI_SLOTS; n += 1) paid += at(`emi_${n}_paid_amount`);
  assert.equal(paid, at('paid_till_date'));
});

test('template: three sheets in the documented order', async () => {
  const wb = await load();
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Admissions', 'Allowed Values', 'Instructions']);
});

test('template: the header row is exactly HEADERS', async () => {
  const wb = await load();
  const row = wb.getWorksheet('Admissions').getRow(1).values.slice(1).map((v) => String(v));
  assert.deepEqual(row, HEADERS);
});

test('template: header is frozen and filterable', async () => {
  const wb = await load();
  const ws = wb.getWorksheet('Admissions');
  assert.equal(ws.views[0].state, 'frozen');
  assert.equal(ws.views[0].ySplit, 1);
  assert.ok(ws.autoFilter, 'autoFilter should be set on the header row');
});

test('template: Allowed Values carries the tenant counsellor emails', async () => {
  const wb = await load();
  // This is the sheet's whole reason for being generated per-tenant: the old
  // CRM exports a "Guided By" first name, and this is what maps it to a user.
  const text = JSON.stringify(wb.getWorksheet('Allowed Values').getSheetValues());
  for (const c of LOOKUPS.counsellors) assert.ok(text.includes(c.email), `${c.email} missing`);
  for (const name of [...LOOKUPS.courses, ...LOOKUPS.centers, ...LOOKUPS.paymentAccounts]) {
    assert.ok(text.includes(name), `${name} missing`);
  }
});

test('template: Instructions documents every error code the worker emits', async () => {
  const wb = await load();
  const text = JSON.stringify(wb.getWorksheet('Instructions').getSheetValues());
  // An operator hitting a code with no entry here has nowhere to go.
  for (const code of [
    'MISSING_IDENTITY', 'MISSING_CONTACT', 'INVALID_EMAIL', 'INVALID_PHONE',
    'INVALID_DATE', 'INVALID_NUMBER', 'INVALID_STATUS', 'INVALID_TRAINING_MODE',
    'INVALID_PAYMENT_MODE', 'INVALID_COLLECTION_MODE', 'INVALID_GRADE_UNIT',
    'INVALID_GRADE', 'INVALID_YEAR', 'EMI_GAP', 'EMI_INCOMPLETE',
    'FEE_MATH_MISMATCH', 'PAID_EXCEEDS_DUE', 'PAID_MISMATCH',
    'DUPLICATE_UTR', 'UTR_ALREADY_USED', 'OWNER_NOT_FOUND', 'OWNER_NOT_COUNSELLOR',
    'PHOTO_NOT_FOUND', 'PROOF_NOT_FOUND', 'DUPLICATE_SKIPPED', 'ADMISSION_EXISTS',
    'COUNTRY_NOT_FOUND', 'BRANCH_NOT_FOUND', 'PAYMENT_ACCOUNT_NOT_FOUND',
    'MISSING_COURSE', 'MISSING_COURSE_FEES', 'MISSING_ADMISSION_DATE', 'ROW_FAILED',
  ]) {
    assert.ok(text.includes(code), `${code} is not documented on the Instructions sheet`);
  }
});

test('template: survives a tenant with nothing configured yet', async () => {
  // A brand-new tenant downloading the template must not get a crash.
  const buf = await buildTemplateXlsx({
    counsellors: [], courses: [], centers: [], branches: [], paymentAccounts: [],
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(buf));
  assert.equal(wb.worksheets.length, 3);
});
