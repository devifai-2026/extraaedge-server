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
const loadWorksheet = async (buffer, maxBytes) => {
  if (buffer && buffer.length > maxBytes) {
    const err = new Error(`Spreadsheet too large to parse (${(buffer.length / (1024 * 1024)).toFixed(1)} MB; max ${Math.round(maxBytes / (1024 * 1024))} MB). Re-save it as a fresh .xlsx to drop embedded dropdown data.`);
    err.code = 'XLSX_TOO_LARGE';
    throw err;
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return { wb: null, ws: null, headers: [] };
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber - 1] = String(cell.value ?? '').trim();
  });
  return { wb, ws, headers };
};

const extractRows = (ws, headers) => {
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
    if (!hasValue) continue;
    // The TRUE spreadsheet row number, kept non-enumerable so it never shows
    // up in Object.entries / spread / JSON.stringify — existing callers that
    // copy every key of a row (bulk-import-worker's applyMapping, the
    // raw_row_json audit blob) stay exactly as they were.
    //
    // It matters because this array is compacted: a blank row in the middle
    // of a sheet shifts every later index, so "row N" in an error message
    // would point at the wrong line, and an embedded image's anchor (which
    // is a real sheet row) could not be matched to its record at all.
    Object.defineProperty(obj, '__sheetRow', { value: r, enumerable: false });
    rows.push(obj);
  }
  return rows;
};

export const parseXlsxBuffer = async (buffer, { maxBytes = MAX_XLSX_BYTES } = {}) => {
  const { ws, headers } = await loadWorksheet(buffer, maxBytes);
  if (!ws) return [];
  return extractRows(ws, headers);
};

// Same as parseXlsxBuffer, plus any images embedded in the sheet, each mapped
// back to the row and column it sits on.
//
// Why this exists: telling someone to name a file in a cell AND attach that
// file separately is two ways of saying one thing, and the two drift the
// moment a file is renamed. Pasting the screenshot into the cell is what
// people actually do, so we read it from there.
//
// Anchoring: ExcelJS gives each image a top-left anchor in 0-based
// (nativeRow, nativeCol). Row 1 is the header, so anything anchored above
// row 2, or in a column with no header, isn't part of the table and is
// dropped rather than guessed at.
export const parseXlsxWithImages = async (buffer, { maxBytes = MAX_XLSX_BYTES } = {}) => {
  const { wb, ws, headers } = await loadWorksheet(buffer, maxBytes);
  if (!ws) return { rows: [], images: [] };
  const rows = extractRows(ws, headers);

  const images = [];
  for (const img of (typeof ws.getImages === 'function' ? ws.getImages() : [])) {
    const media = wb.getImage(Number(img.imageId));
    if (!media?.buffer) continue;
    const sheetRow = (img.range?.tl?.nativeRow ?? 0) + 1;
    const column = headers[img.range?.tl?.nativeCol ?? 0];
    if (!column || sheetRow < 2) continue;
    images.push({
      sheetRow,
      column,
      buffer: media.buffer,
      extension: (media.extension || 'png').replace(/^\./u, ''),
    });
  }
  return { rows, images };
};

// Pick a parser by file extension. Workers and routes can call this without
// knowing whether the upload is CSV or XLSX.
export const parseSpreadsheetBuffer = async (buffer, filenameOrKey, opts) => {
  const isXlsx = /\.xlsx$/i.test(filenameOrKey ?? '');
  return isXlsx ? parseXlsxBuffer(buffer, opts) : parseCsvBuffer(buffer);
};
