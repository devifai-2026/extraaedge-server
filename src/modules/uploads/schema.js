import { z } from 'zod';

export const presignSchema = z.object({
  purpose: z.enum(['avatar', 'brochure', 'note_attachment', 'ticket_attachment', 'template_asset', 'csv_import', 'export_result', 'recording', 'pdf_report']),
  content_type: z.string().min(1),
  size_bytes: z.coerce.number().int().positive().max(1024 * 1024 * 1024), // up to 1 GB signed
  ref_entity_type: z.string().optional(),
  ref_entity_id: z.string().uuid().optional(),
  filename: z.string().optional(),
});

export const confirmSchema = z.object({
  r2_key: z.string().min(1),
  size_bytes: z.coerce.number().int().positive().optional(),
  checksum_sha256: z.string().optional(),
  purpose: z.enum(['avatar', 'brochure', 'note_attachment', 'ticket_attachment', 'template_asset', 'csv_import', 'export_result', 'recording', 'pdf_report']),
  ref_entity_type: z.string().optional(),
  ref_entity_id: z.string().uuid().optional(),
  visibility: z.enum(['private', 'tenant', 'public_signed']).default('private'),
});

export const idParam = z.object({ id: z.string().uuid() });
