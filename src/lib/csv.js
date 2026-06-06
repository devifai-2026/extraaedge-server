import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import ExcelJS from 'exceljs';

export const parseCsvBuffer = (buffer, { columns = true, skip_empty_lines = true } = {}) =>
  new Promise((resolve, reject) => {
    parse(buffer, { columns, skip_empty_lines, trim: true }, (err, records) => {
      if (err) return reject(err);
      return resolve(records);
    });
  });

export const streamCsv = (records, { header = true, columns } = {}) =>
  new Promise((resolve, reject) => {
    stringify(records, { header, columns }, (err, out) => {
      if (err) return reject(err);
      resolve(out);
    });
  });

export const rowsToCsv = async (rows, columns) => streamCsv(rows, { header: true, columns });

// Flatten a single ExcelJS cell value to the shape downstream workers expect:
// a Date (kept intact for IST re-interpretation) or a trimmed string.
const flattenCellValue = (v) => {
  // Special-case Date cells: keep the Date object intact so downstream workers
  // can re-interpret the wall-clock components in the correct timezone (IST).
  // If we toISOString()'d here we'd freeze the value as UTC, and a Node process
  // running in UTC TZ would corrupt every Excel-auto-formatted date by 5h30m.
  // The worker's parseCsvDate handles Date instances explicitly.
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? '' : v;
  }
  // ExcelJS returns rich objects for some cell types; flatten to strings.
  if (v && typeof v === 'object') {
    if (v.text) v = v.text;
    else if (v.result !== undefined) v = v.result;
    else if (v.richText) v = v.richText.map((p) => p.text).join('');
    else v = String(v);
  }
  return v === null || v === undefined ? '' : String(v).trim();
};

// Hard ceiling on the raw .xlsx bytes we'll feed to ExcelJS. load() buffers the
// fully-unzipped workbook XML, so a small *compressed* file with megabytes of
// embedded data-validation dropdown lists (the bloated-template pattern) can
// unzip to hundreds of MB and OOM-kill the worker — which, when the worker
// shares the web process, takes the API down and surfaces in the browser as a
// bare "Failed to fetch" mid-upload. The presign + client guards reject these
// before storage; this is the defence-in-depth check on the already-stored
// file. Mirrors the 25 MB csv_import presign cap.
const MAX_XLSX_BYTES = 25 * 1024 * 1024;

// Parse an .xlsx buffer into an array of {column: value} objects, mirroring
// the shape returned by parseCsvBuffer so worker code can treat both
// uniformly. Reads the first worksheet only — bulk lead templates are
// expected to be single-sheet. Header row is row 1.
//
// We use Workbook.xlsx.load() rather than the streaming WorkbookReader on
// purpose: the streaming reader returns Excel date cells as raw serial numbers
// (it can't reliably resolve the cell's number-format mid-stream), whereas
// load() yields real Date objects — which parseCsvDate() in the import worker
// depends on for IST-correct date handling. To keep load() memory-safe we cap
// the input size up front (MAX_XLSX_BYTES) and trim empty trailing rows below.
export const parseXlsxBuffer = async (buffer) => {
  if (buffer && buffer.length > MAX_XLSX_BYTES) {
    const err = new Error(`Spreadsheet too large to parse (${(buffer.length / (1024 * 1024)).toFixed(1)} MB; max ${Math.round(MAX_XLSX_BYTES / (1024 * 1024))} MB). Re-save it as a fresh .xlsx to drop embedded dropdown data.`);
    err.code = 'XLSX_TOO_LARGE';
    throw err;
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber - 1] = String(cell.value ?? '').trim();
  });

  const rows = [];
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const obj = {};
    let hasValue = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const val = flattenCellValue(row.getCell(i + 1).value);
      if (val instanceof Date) {
        obj[h] = val;
        hasValue = true;
        return;
      }
      if (val !== '') hasValue = true;
      obj[h] = val;
    });
    // Trim empty trailing rows: templates often carry thousands of blank
    // pre-formatted rows. A row with no real values is dropped.
    if (hasValue) rows.push(obj);
  }
  return rows;
};

// Pick a parser by file extension. Workers and routes can call this without
// knowing whether the upload is CSV or XLSX.
export const parseSpreadsheetBuffer = async (buffer, filenameOrKey) => {
  const isXlsx = /\.xlsx$/i.test(filenameOrKey ?? '');
  return isXlsx ? parseXlsxBuffer(buffer) : parseCsvBuffer(buffer);
};
