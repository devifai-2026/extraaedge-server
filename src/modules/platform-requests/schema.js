import { z } from 'zod';

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  tenant_id: z.string().uuid().optional(),
  tenant_slug: z.string().optional(),
  actor_email: z.string().optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  category: z.string().optional(),
  status_code: z.coerce.number().int().optional(),
  status_class: z.enum(['2', '3', '4', '5']).optional(),
  errors_only: z.enum(['true', 'false']).optional(),
  request_id: z.string().optional(),
  path: z.string().optional(),
  date_from: z.string().optional(), // ISO timestamp
  date_to: z.string().optional(),
});

export const idParam = z.object({ id: z.string().uuid() });
