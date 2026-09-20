// Speedup Hiring — background importer for the candidate and interview sheets.
//
// Runs out of band because a real recruitment workbook is hundreds of rows and
// the recruiter should not sit on a spinner while it is validated and written.
// The route queues a job and returns immediately; the UI polls the import row.
//
// Every rejected row and every row that UPDATED an existing candidate is
// persisted to hiring_import_rows, so "which 14 rows failed and why" is still
// answerable days later, on its own tab, without re-opening the file.
//
// Own queue, not a second job name on BULK_IMPORT: in in-process mode
// registerWorker binds jobName '*', so sharing a queue would hand every
// lead-import job to this worker as well.
import { registerWorker } from '../lib/queue.js';
import { QUEUE_NAMES } from '../config/constants.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { getDownloadSignedUrl } from '../lib/r2.js';
import { parseXlsxSheet, parseCsvBuffer } from '../lib/csv.js';
import * as service from '../modules/hiring/service.js';
import * as repo from '../modules/hiring/repo.js';
import { logger } from '../lib/logger.js';

const fetchByKey = async (key) => {
  const url = await getDownloadSignedUrl({ key, expiresIn: 120 });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download upload: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

const setStatus = (tenant, id, patch) => {
  const sets = [];
  const vals = [id];
  for (const [k, v] of Object.entries(patch)) {
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  return tenantQuery(tenant, `UPDATE hiring_imports SET ${sets.join(', ')} WHERE id = $1`, vals);
};

const recordRow = (tenant, importId, row) => tenantQuery(
  tenant,
  `INSERT INTO hiring_import_rows (import_id, row_no, outcome, reason, raw, candidate_id)
   VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
  [importId, row.row_no, row.outcome, row.reason ?? null,
    JSON.stringify(row.raw ?? {}), row.candidate_id ?? null],
);

// Read the uploaded file into raw objects. .xlsx reads the chosen sheet;
// anything else is treated as CSV.
const readRows = async (buffer, fileName, sheetName) => {
  if (/\.xlsx$/i.test(fileName || '')) {
    const { rows } = await parseXlsxSheet(buffer, sheetName || null);
    return rows;
  }
  return parseCsvBuffer(buffer);
};

registerWorker(QUEUE_NAMES.HIRING_IMPORT, async ({ data }) => {
  const tenant = await resolveTenantById(data.tenantId);
  if (!tenant) return;
  const { import_id: importId } = data;

  const { rows: jobRows } = await tenantQuery(
    tenant, `SELECT * FROM hiring_imports WHERE id = $1`, [importId],
  );
  const job = jobRows[0];
  if (!job) return;

  try {
    await setStatus(tenant, importId, { status: 'processing' });

    const buffer = await fetchByKey(job.file_key);
    const raw = await readRows(buffer, job.file_name, job.sheet_name);
    // The client already mapped headers for the paste path; a file read here
    // has not been through that, so map now using the same table.
    const mapped = service.mapSheetRows(raw, job.kind);
    await setStatus(tenant, importId, { total_rows: mapped.length });

    if (!mapped.length) {
      await setStatus(tenant, importId, {
        status: 'completed', finished_at: new Date().toISOString(),
      });
      return;
    }

    const preview = job.kind === 'interview'
      ? await service.previewInterviews(tenant, { rows: mapped, position_id: job.position_id })
      : await service.previewCandidates(tenant, { rows: mapped, position_id: job.position_id });

    // Persist every rejected row before writing anything, so a later failure
    // still leaves the recruiter with the list of what was wrong.
    for (const f of preview.failed) {
      await recordRow(tenant, importId, {
        row_no: f.row, outcome: 'failed', reason: f.reason, raw: f.data,
      });
    }

    let created = 0;
    let updated = 0;
    if (preview.rows.length) {
      const res = job.kind === 'interview'
        ? await repo.commitInterviews(tenant, preview.rows, job.created_by)
        : await repo.commitCandidates(tenant, preview.rows, job.created_by);
      created = res.created ?? 0;
      updated = res.updated ?? 0;
      // An interview import can mint candidates as a side effect; count those
      // as created so the totals add up for the reader.
      if (job.kind === 'interview') created = res.created ?? 0;
    }

    // Rows that matched an existing candidate updated it rather than inserting.
    // Recorded as 'duplicate' — not an error, but the reason the created count
    // is lower than the row count, which otherwise looks like data loss.
    if (job.kind === 'candidate') {
      for (const r of preview.rows.filter((x) => x._duplicate)) {
        await recordRow(tenant, importId, {
          row_no: r._row_no ?? 0,
          outcome: 'duplicate',
          reason: `Already in the pool for this position — updated instead of added`,
          raw: { name: r.name, phone: r.phone },
        });
      }
    }

    await setStatus(tenant, importId, {
      status: 'completed',
      created_rows: created,
      updated_rows: updated,
      failed_rows: preview.failed.length,
      duplicate_rows: job.kind === 'candidate' ? preview.updates ?? 0 : 0,
      unknown_statuses: JSON.stringify(preview.unknown_statuses ?? []),
      finished_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err: err.message, importId }, 'hiring import failed');
    await setStatus(tenant, importId, {
      status: 'failed',
      error: err.message?.slice(0, 500) ?? 'Import failed',
      finished_at: new Date().toISOString(),
    }).catch(() => {});
  }
});
