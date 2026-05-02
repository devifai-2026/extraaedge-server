import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';

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
