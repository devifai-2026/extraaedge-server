import { registerWorker } from '../lib/queue.js';
import { QUEUE_NAMES } from '../config/constants.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { rowsToCsv } from '../lib/csv.js';
import { putObject, buildKey } from '../lib/r2.js';
import { nanoid } from 'nanoid';
import { logger } from '../lib/logger.js';

registerWorker(QUEUE_NAMES.BULK_EXPORT, async ({ data }) => {
  const tenant = await resolveTenantById(data.tenantId);
  if (!tenant) return;
  await tenantQuery(tenant, `UPDATE bulk_exports SET status = 'processing', started_at = now() WHERE id = $1`, [data.export_id]);
  try {
    const { rows: [exp] } = await tenantQuery(tenant, `SELECT * FROM bulk_exports WHERE id = $1`, [data.export_id]);
    if (!exp) return;
    const filter = exp.filter_json ?? {};
    const conds = ['deleted_at IS NULL'];
    const params = [];
    if (filter.stage_ids) { params.push(filter.stage_ids); conds.push(`stage_id = ANY($${params.length}::uuid[])`); }
    if (filter.assigned_to) { params.push(filter.assigned_to); conds.push(`assigned_to = ANY($${params.length}::uuid[])`); }
    const columns = exp.columns && exp.columns.length
      ? exp.columns
      : ['id', 'name', 'email', 'phone', 'stage_id', 'assigned_to', 'program_id', 'lead_score', 'created_at'];
    const { rows } = await tenantQuery(tenant, `SELECT ${columns.map((c) => `"${c}"`).join(',')} FROM leads WHERE ${conds.join(' AND ')}`, params);
    const csv = await rowsToCsv(rows, columns);
    const key = buildKey({ tenantSlug: tenant.slug, purpose: 'export_result', id: nanoid(20), ext: 'csv' });
    await putObject({ key, body: csv, contentType: 'text/csv' });
    await tenantQuery(tenant, `UPDATE bulk_exports SET status = 'completed', file_r2_key = $2, row_count = $3, completed_at = now() WHERE id = $1`, [data.export_id, key, rows.length]);
  } catch (err) {
    logger.error({ err: err.message, export_id: data.export_id }, 'export failed');
    await tenantQuery(tenant, `UPDATE bulk_exports SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`, [data.export_id, err.message]);
  }
}, { concurrency: 2, jobName: '*' });
