import PDFDocument from 'pdfkit';

// Returns Promise<Buffer>. Caller persists to R2 via r2.putObject.
export const renderPdfToBuffer = (draw) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      draw(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });

export const renderLeadPdf = async ({ lead, tenant, timeline }) =>
  renderPdfToBuffer((doc) => {
    doc.fontSize(18).text(tenant.company_name || tenant.name, { align: 'left' });
    doc.moveDown();
    doc.fontSize(14).text('Lead Profile', { underline: true });
    doc.moveDown();
    doc.fontSize(11);
    doc.text(`Name: ${lead.name ?? ''}`);
    doc.text(`Email: ${lead.email ?? ''}`);
    doc.text(`Phone: ${lead.phone ?? ''}`);
    doc.text(`Stage: ${lead.stage_name ?? ''} / ${lead.sub_stage_name ?? ''}`);
    doc.text(`Program: ${lead.program_name ?? ''}`);
    doc.text(`Assigned to: ${lead.assigned_to_name ?? 'Unassigned'}`);
    doc.text(`Created: ${lead.created_at ?? ''}`);
    doc.moveDown();
    doc.fontSize(14).text('Timeline', { underline: true });
    doc.fontSize(10);
    for (const t of timeline || []) {
      doc.text(`• [${t.created_at}] ${t.type}: ${t.summary ?? ''}`);
    }
  });

export const renderDashboardPdf = async ({ tenant, range, summary }) =>
  renderPdfToBuffer((doc) => {
    doc.fontSize(18).text(`${tenant.company_name || tenant.name} — Dashboard Summary`);
    doc.fontSize(10).fillColor('gray').text(`${range.from} → ${range.to}`);
    doc.fillColor('black').moveDown();
    doc.fontSize(12);
    for (const [key, value] of Object.entries(summary || {})) {
      doc.text(`${key}: ${value}`);
    }
  });
