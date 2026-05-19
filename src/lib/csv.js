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

// Parse an .xlsx buffer into an array of {column: value} objects, mirroring
// the shape returned by parseCsvBuffer so worker code can treat both
// uniformly. Reads the first worksheet only — bulk lead templates are
// expected to be single-sheet. Header row is row 1.
export const parseXlsxBuffer = async (buffer) => {
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
      const cell = row.getCell(i + 1);
      let v = cell.value;

      // Special-case Date cells: keep the Date object intact so downstream
      // workers can re-interpret the wall-clock components in the correct
      // timezone (IST). If we toISOString()'d here we'd freeze the value as
      // UTC, and a Node process running in UTC TZ would corrupt every
      // Excel-auto-formatted date by 5h30m. The worker's parseCsvDate
      // handles Date instances explicitly.
      if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) {
          obj[h] = '';
          return;
        }
        obj[h] = v;
        hasValue = true;
        return;
      }

      // ExcelJS returns rich objects for some cell types; flatten to strings.
      if (v && typeof v === 'object') {
        if (v.text) v = v.text;
        else if (v.result !== undefined) v = v.result;
        else if (v.richText) v = v.richText.map((p) => p.text).join('');
        else v = String(v);
      }
      const str = v === null || v === undefined ? '' : String(v).trim();
      if (str !== '') hasValue = true;
      obj[h] = str;
    });
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
