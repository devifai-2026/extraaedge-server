import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBlank, normalizePhone, parseCsvDate, parseSheetDate, parseSheetNumber,
} from '../../src/lib/spreadsheet-values.js';

test('isBlank', () => {
  assert.equal(isBlank(undefined), true);
  assert.equal(isBlank(null), true);
  assert.equal(isBlank('   '), true);
  assert.equal(isBlank(0), false);
  assert.equal(isBlank('x'), false);
});

test('normalizePhone: blank vs invalid vs valid', () => {
  // '' means "nothing supplied", null means "supplied but unusable" — callers
  // rely on that difference to decide whether to fail the row.
  assert.equal(normalizePhone(''), '');
  assert.equal(normalizePhone(undefined), '');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('8446502554'), '+918446502554');
  assert.equal(normalizePhone('+918446502554'), '+918446502554');
  assert.equal(normalizePhone('918446502554'), '+918446502554');
  assert.equal(normalizePhone('844 650 2554'), '+918446502554');
});

test('parseCsvDate: IST anchoring, not UTC', () => {
  // 14:55 IST is 09:25 UTC. Getting this wrong silently shifted every
  // imported follow-up by 5h30m.
  const d = parseCsvDate('24-05-2026 14:55:00');
  assert.equal(d.toISOString(), '2026-05-24T09:25:00.000Z');
});

test('parseCsvDate: blank vs unparseable', () => {
  assert.equal(parseCsvDate(''), undefined);
  assert.equal(parseCsvDate('not a date'), null);
  assert.equal(parseCsvDate('05/24/2026'), null); // US order is rejected, not guessed
  assert.equal(parseCsvDate('32-01-2026 10:00:00'), null);
});

test('parseSheetDate: accepts the formats an operator will actually paste', () => {
  assert.equal(parseSheetDate('20-07-2026'), '2026-07-20');
  assert.equal(parseSheetDate('20/07/2026'), '2026-07-20');
  assert.equal(parseSheetDate('2026-07-20'), '2026-07-20');
  // The shape a pay-schedule export from the previous CRM emits.
  assert.equal(parseSheetDate('21-Jul-2026'), '2026-07-21');
  assert.equal(parseSheetDate('5-7-2026'), '2026-07-05');
});

test('parseSheetDate: a real Excel date cell keeps its displayed day', () => {
  // ExcelJS builds these at UTC midnight. Running them through the IST
  // re-anchoring used for timestamps would roll them back a day.
  const cell = new Date(Date.UTC(2026, 6, 20, 0, 0, 0));
  assert.equal(parseSheetDate(cell), '2026-07-20');
});

test('parseSheetDate: blank vs unparseable vs impossible', () => {
  assert.equal(parseSheetDate(''), undefined);
  assert.equal(parseSheetDate('   '), undefined);
  assert.equal(parseSheetDate('sometime in July'), null);
  assert.equal(parseSheetDate('31-02-2026'), null); // must not roll into March
  assert.equal(parseSheetDate('20-13-2026'), null);
  assert.equal(parseSheetDate('20-07-1850'), null);
});

test('parseSheetDate: leap years', () => {
  assert.equal(parseSheetDate('29-02-2024'), '2024-02-29');
  assert.equal(parseSheetDate('29-02-2023'), null);
  assert.equal(parseSheetDate('29-02-2000'), '2000-02-29');
  assert.equal(parseSheetDate('29-02-1900'), null); // divisible by 100, not 400
});

test('parseSheetNumber: tolerates export formatting', () => {
  assert.equal(parseSheetNumber(37000), 37000);
  assert.equal(parseSheetNumber('37000'), 37000);
  assert.equal(parseSheetNumber('37,000'), 37000);
  assert.equal(parseSheetNumber('₹ 37,000'), 37000);
  assert.equal(parseSheetNumber('2500.50'), 2500.5);
});

test('parseSheetNumber: blank vs unparseable, and 0 is a real value', () => {
  assert.equal(parseSheetNumber(''), undefined);
  assert.equal(parseSheetNumber(null), undefined);
  assert.equal(parseSheetNumber('abc'), null);
  // 0 must survive as 0 — it's how the sheet says "this installment is
  // entirely unpaid", which is different from leaving the cell empty.
  assert.equal(parseSheetNumber(0), 0);
  assert.equal(parseSheetNumber('0'), 0);
});
