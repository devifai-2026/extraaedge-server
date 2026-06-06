import { z } from 'zod';

const MB = 1024 * 1024;

// Per-purpose upload size ceilings. The presign signature also enforces these
// at GCS (contentLengthRange), but rejecting here gives the client a clean
// 400 with a useful message before it ever PUTs the file.
//
// csv_import is intentionally tight: a legitimate lead spreadsheet is a few KB
// per row, so even a 100k-row import stays well under 25 MB. A 20-row file in
// the megabytes is a bloated template (embedded dropdown lists / styling) that
// OOMs the parse worker — we'd rather bounce it at the door.
export const UPLOAD_SIZE_LIMITS = {
  avatar: 5 * MB,
  brochure: 50 * MB,
  note_attachment: 25 * MB,
  ticket_attachment: 25 * MB,
  template_asset: 25 * MB,
  csv_import: 25 * MB,
  export_result: 200 * MB,
  recording: 500 * MB,
  pdf_report: 50 * MB,
  admission_photo: 10 * MB,
  receipt_screenshot: 10 * MB,
};
const DEFAULT_UPLOAD_SIZE_LIMIT = 1024 * MB; // 1 GB fallback

export const presignSchema = z.object({
  purpose: z.enum(['avatar', 'brochure', 'note_attachment', 'ticket_attachment', 'template_asset', 'csv_import', 'export_result', 'recording', 'pdf_report', 'admission_photo', 'receipt_screenshot']),
  content_type: z.string().min(1),
  size_bytes: z.coerce.number().int().positive().max(1024 * 1024 * 1024), // up to 1 GB signed
  ref_entity_type: z.string().optional(),
  ref_entity_id: z.string().uuid().optional(),
  filename: z.string().optional(),
}).superRefine((val, ctx) => {
  const limit = UPLOAD_SIZE_LIMITS[val.purpose] ?? DEFAULT_UPLOAD_SIZE_LIMIT;
  if (val.size_bytes > limit) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['size_bytes'],
      message: `File too large for ${val.purpose}: ${(val.size_bytes / MB).toFixed(1)} MB exceeds the ${Math.round(limit / MB)} MB limit`,
    });
  }
});

export const confirmSchema = z.object({
  r2_key: z.string().min(1),
  size_bytes: z.coerce.number().int().positive().optional(),
  checksum_sha256: z.string().optional(),
  purpose: z.enum(['avatar', 'brochure', 'note_attachment', 'ticket_attachment', 'template_asset', 'csv_import', 'export_result', 'recording', 'pdf_report', 'admission_photo', 'receipt_screenshot']),
  ref_entity_type: z.string().optional(),
  ref_entity_id: z.string().uuid().optional(),
  visibility: z.enum(['private', 'tenant', 'public_signed']).default('private'),
});

export const idParam = z.object({ id: z.string().uuid() });
