import { z } from 'zod';

export const listQuery = z.object({
  unread_only: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const idParam = z.object({ id: z.string().uuid() });
