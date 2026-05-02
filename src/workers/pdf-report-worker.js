import { registerWorker } from '../lib/queue.js';
import { QUEUE_NAMES } from '../config/constants.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { renderLeadPdf, renderDashboardPdf } from '../lib/pdf.js';
import { putObject, buildKey } from '../lib/r2.js';
import { nanoid } from 'nanoid';
import { logger } from '../lib/logger.js';

registerWorker(QUEUE_NAMES.PDF, async ({ name, data }) => {
  const tenant = await resolveTenantById(data.tenantId);
  if (!tenant) return;
  try {
    let buffer; let key;
    if (name === 'lead_pdf') {
      const { rows: [lead] } = await tenantQuery(tenant, `SELECT * FROM leads WHERE id = $1`, [data.lead_id]);
      const { rows: timeline } = await tenantQuery(tenant, `SELECT type, summary, created_at FROM lead_activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 200`, [data.lead_id]);
      buffer = await renderLeadPdf({ lead, tenant, timeline });
      key = buildKey({ tenantSlug: tenant.slug, purpose: 'pdf_report', id: nanoid(20), ext: 'pdf' });
    } else if (name === 'dashboard_pdf') {
      const { rows } = await tenantQuery(tenant, `SELECT count(*)::int AS total_leads FROM leads WHERE deleted_at IS NULL AND created_at BETWEEN $1 AND $2`, [data.params.date_from, data.params.date_to]);
      buffer = await renderDashboardPdf({ tenant, range: { from: data.params.date_from, to: data.params.date_to }, summary: { total_leads: rows[0].total_leads } });
      key = buildKey({ tenantSlug: tenant.slug, purpose: 'pdf_report', id: nanoid(20), ext: 'pdf' });
    }
    if (buffer && key) {
      await putObject({ key, body: buffer, contentType: 'application/pdf' });
      await tenantQuery(tenant, `UPDATE bulk_exports SET status = 'completed', file_r2_key = $2, completed_at = now() WHERE id = $1`, [data.job_id, key]);
    }
  } catch (err) {
    logger.error({ err: err.message, job_id: data.job_id }, 'pdf-report failed');
    await tenantQuery(tenant, `UPDATE bulk_exports SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`, [data.job_id, err.message]);
  }
}, { concurrency: 2, jobName: '*' });
