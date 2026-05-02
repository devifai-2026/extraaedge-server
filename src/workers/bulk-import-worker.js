import { registerWorker } from '../lib/queue.js';
import { QUEUE_NAMES } from '../config/constants.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { getDownloadSignedUrl } from '../lib/r2.js';
import { parseCsvBuffer } from '../lib/csv.js';
import { findDuplicates, insertLead } from '../modules/leads/repo.js';
import { logger } from '../lib/logger.js';

const fetchCsvByKey = async (key) => {
  const url = await getDownloadSignedUrl({ key, expiresIn: 60 });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download CSV: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

const applyMapping = (row, mapping, defaults) => {
  const out = { ...defaults };
  for (const [src, tgt] of Object.entries(mapping)) {
    if (row[src] !== undefined && row[src] !== '') out[tgt] = row[src];
  }
  return out;
};

registerWorker(QUEUE_NAMES.BULK_IMPORT, async ({ name, data }) => {
  const tenant = await resolveTenantById(data.tenantId);
  if (!tenant) return;

  if (name === 'preview') {
    try {
      const { rows: [preview] } = await tenantQuery(tenant, `SELECT * FROM bulk_import_previews WHERE id = $1`, [data.preview_id]);
      if (!preview) return;
      const csv = await fetchCsvByKey(preview.file_r2_key);
      const rows = await parseCsvBuffer(csv);
      const mapping = preview.field_mapping_json ?? {};
      const defaults = preview.defaults_json ?? {};
      let valid = 0; let invalid = 0; let duplicates = 0;
      const errorSamples = [];
      const dupSamples = [];
      for (const [i, row] of rows.entries()) {
        const mapped = applyMapping(row, mapping, defaults);
        if (!mapped.name && !mapped.first_name && !mapped.email && !mapped.phone && !mapped.whatsapp_number) {
          invalid += 1;
          if (errorSamples.length < 50) errorSamples.push({ row_number: i + 2, error_code: 'MISSING_CONTACT', error_message: 'Row has no name/email/phone/whatsapp' });
          continue;
        }
        valid += 1;
        if (mapped.phone || mapped.email) {
          const matches = await findDuplicates(tenant, { phone: mapped.phone, email: mapped.email, whatsapp_number: mapped.whatsapp_number });
          if (matches.length) {
            duplicates += 1;
            if (dupSamples.length < 50) dupSamples.push({ row_number: i + 2, matches });
          }
        }
      }
      await tenantQuery(
        tenant,
        `UPDATE bulk_import_previews
            SET total_rows = $2, valid_rows = $3, invalid_rows = $4, duplicate_rows = $5,
                sample_errors_json = $6::jsonb, duplicate_matches_json = $7::jsonb
          WHERE id = $1`,
        [data.preview_id, rows.length, valid, invalid, duplicates, JSON.stringify(errorSamples), JSON.stringify(dupSamples)],
      );
    } catch (err) {
      logger.error({ err: err.message, preview_id: data.preview_id }, 'bulk preview failed');
    }
    return;
  }

  if (name === 'commit' || name === 'retry') {
    const import_id = data.import_id ?? data.new_import_id;
    try {
      await tenantQuery(tenant, `UPDATE bulk_imports SET status = 'processing', started_at = now() WHERE id = $1`, [import_id]);
      const { rows: [imp] } = await tenantQuery(tenant, `SELECT * FROM bulk_imports WHERE id = $1`, [import_id]);
      if (!imp) return;
      const csv = await fetchCsvByKey(imp.file_r2_key);
      const rows = await parseCsvBuffer(csv);
      const mapping = imp.field_mapping_json ?? {};
      const defaults = imp.defaults_json ?? {};
      let success = 0; let failed = 0; let duplicates = 0;
      for (const [i, row] of rows.entries()) {
        const mapped = applyMapping(row, mapping, defaults);
        try {
          const dups = await findDuplicates(tenant, { phone: mapped.phone, email: mapped.email, whatsapp_number: mapped.whatsapp_number });
          if (dups.length) {
            duplicates += 1;
            if (imp.duplicate_handling === 'skip') continue;
            if (imp.duplicate_handling === 'update_existing') {
              await tenantQuery(
                tenant,
                `UPDATE leads SET
                   name = COALESCE(NULLIF($2,''), name),
                   email = COALESCE(NULLIF($3,'')::citext, email),
                   last_activity_at = now()
                 WHERE id = $1`,
                [dups[0].id, mapped.name ?? '', mapped.email ?? ''],
              );
              success += 1;
              continue;
            }
            // create_new: fall through
          }
          await insertLead(tenant, mapped, imp.user_id);
          success += 1;
        } catch (err) {
          failed += 1;
          await tenantQuery(
            tenant,
            `INSERT INTO bulk_import_failures (import_id, row_number, raw_row_json, error_code, error_message)
             VALUES ($1,$2,$3::jsonb,'ROW_FAILED',$4)`,
            [import_id, i + 2, JSON.stringify(row), err.message.slice(0, 500)],
          );
        }
      }
      await tenantQuery(
        tenant,
        `UPDATE bulk_imports SET status = 'completed', completed_at = now(), total_rows = $2, success_rows = $3, failed_rows = $4, duplicate_rows = $5 WHERE id = $1`,
        [import_id, rows.length, success, failed, duplicates],
      );
    } catch (err) {
      logger.error({ err: err.message, import_id }, 'bulk import failed');
      await tenantQuery(tenant, `UPDATE bulk_imports SET status = 'failed', completed_at = now() WHERE id = $1`, [import_id]);
    }
    return;
  }

  if (name === 'retry_row' && data.failure_id) {
    const { rows: [fail] } = await tenantQuery(tenant, `SELECT * FROM bulk_import_failures WHERE id = $1`, [data.failure_id]);
    if (!fail) return;
    try {
      await insertLead(tenant, fail.raw_row_json, null);
      await tenantQuery(tenant, `UPDATE bulk_import_failures SET retried_at = now() WHERE id = $1`, [data.failure_id]);
    } catch (err) {
      logger.error({ err: err.message, failure_id: data.failure_id }, 'retry_row failed');
    }
  }
}, { concurrency: 2, jobName: '*' });
