// Shared value parsers for spreadsheet imports.
//
// Extracted from bulk-import-worker.js when a second importer (the Accounts
// historical-admission import) needed the same logic. Workers can't import
// each other — loading a worker module runs its registerWorker side effect —
// so anything two of them share has to live here.
//
// The IST handling below is the load-bearing part. Do not "simplify" it.

export const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

// Accepts +91xxxxxxxxxx, 91xxxxxxxxxx, or a bare 10-digit mobile. The
// templates document the +CC form but real uploads are messy, so we accept
// more shapes and normalise.
//
// Returns '' for blank input, null for a value that IS present but isn't a
// usable number (callers treat that as a row error), otherwise +CC form.
export const normalizePhone = (raw) => {
  if (!raw) return '';
  const digits = String(raw).replace(/[^\d+]/gu, '');
  if (!digits) return '';
  const noPlus = digits.replace(/^\+/u, '');
  if (noPlus.length < 10 || noPlus.length > 15) return null;
  return digits.startsWith('+') ? digits : `+${noPlus.length === 10 ? `91${noPlus}` : noPlus}`;
};

const DDMMYYYY_HHMMSS_RE = /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/u;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/u;
export const IST_OFFSET_MIN = 330; // 5h 30m, no DST

// Re-interpret a Date's wall-clock components as IST and return the matching
// UTC Date.
//
// ExcelJS hands back real Date instances for cells the spreadsheet formatted
// as dates, but those are constructed in the Node process's local TZ — which
// on most servers is UTC. So "24-05-2026 14:55" (meant as IST) would land as
// 14:55 UTC instead of 09:25 UTC: a silent 5h30m drift on every imported
// timestamp. We read the digits the user actually typed (the Date's UTC
// components) and re-anchor them to IST.
export const reinterpretAsIst = (d) => new Date(
  Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(),
  ) - IST_OFFSET_MIN * 60_000,
);

// Timestamp parser for the bulk-lead template's datetime columns.
//
// Returns a Date on success, null for a value that doesn't match any accepted
// format, and undefined for blank input — so callers can tell "not provided"
// from "provided but wrong".
//
// Accepted, in precedence order:
//   • a real Date (ExcelJS auto-formatted the cell) → re-anchored to IST
//   • ISO 8601 (csv.js flattened a Date cell before the worker saw it)
//   • the documented "DD-MM-YYYY HH:mm:ss" plain-text form
//
// Anything else — US MM/DD/YYYY, a bare date, free text — is rejected rather
// than guessed, so a format mixup can't silently corrupt a timeline.
export const parseCsvDate = (raw) => {
  if (isBlank(raw)) return undefined;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return reinterpretAsIst(raw);
  }
  const s = String(raw).trim();

  if (ISO_RE.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const m = DDMMYYYY_HHMMSS_RE.exec(s);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  const d = new Date(Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi, +ss) - IST_OFFSET_MIN * 60_000);
  // Round-trip check so 32-01-2026 is rejected rather than rolling into Feb.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  if (
    Number(parts.year) !== +yyyy
    || Number(parts.month) !== +mm
    || Number(parts.day) !== +dd
  ) return null;
  return d;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE_ONLY_RE = /^(\d{1,2})[-/.](\d{1,2}|[A-Za-z]{3,})[-/.](\d{4})$/u;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/u;

const pad2 = (n) => String(n).padStart(2, '0');

// Calendar-date parser for `date` columns (admission_date, due dates, receipt
// dates). Returns a 'YYYY-MM-DD' string, null when unparseable, undefined
// when blank.
//
// Deliberately NOT parseCsvDate: these map to Postgres `date`, which has no
// time or zone. Running them through the IST re-anchoring above would shift
// a midnight-anchored value back into the previous day. So we read the
// wall-clock date the user typed and format it verbatim, with no TZ maths.
//
// Accepted: a real Excel date cell, YYYY-MM-DD (and full ISO), DD-MM-YYYY,
// and DD-MMM-YYYY. That last one matters: it's what the pay-schedule exports
// institutes migrate from actually emit ("21-Jul-2026"), so an operator who
// pastes a column straight across gets a working sheet instead of 55 errors.
export const parseSheetDate = (raw) => {
  if (isBlank(raw)) return undefined;

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    // UTC components are the digits shown in the cell — see reinterpretAsIst.
    return `${raw.getUTCFullYear()}-${pad2(raw.getUTCMonth() + 1)}-${pad2(raw.getUTCDate())}`;
  }

  const s = String(raw).trim();

  const iso = ISO_DATE_RE.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    return isRealDate(+y, +m, +d) ? `${y}-${m}-${d}` : null;
  }

  const m = DATE_ONLY_RE.exec(s);
  if (!m) return null;
  const [, dayRaw, monthRaw, yearRaw] = m;
  let month;
  if (/^\d+$/u.test(monthRaw)) {
    month = Number(monthRaw);
  } else {
    month = MONTHS.indexOf(monthRaw.slice(0, 3).toLowerCase()) + 1;
    if (month === 0) return null;
  }
  const day = Number(dayRaw);
  const year = Number(yearRaw);
  if (!isRealDate(year, month, day)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
};

// Rejects 31-02-2026 and friends. Cheap explicit check rather than a Date
// round-trip, which would silently roll the value into the next month.
const isRealDate = (year, month, day) => {
  if (month < 1 || month > 12 || day < 1) return false;
  if (year < 1900 || year > 2100) return false;
  const daysInMonth = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
};

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// Amount / count parser. Returns a Number, null when the cell holds something
// non-numeric, undefined when blank. Tolerates the thousands separators,
// currency symbols and stray spaces that survive a CRM export.
export const parseSheetNumber = (raw) => {
  if (isBlank(raw)) return undefined;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const cleaned = String(raw).replace(/[,\s₹$]/gu, '');
  if (cleaned === '') return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};
