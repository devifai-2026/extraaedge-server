import { z } from 'zod';

export const startImpersonationSchema = z.object({
  tenant_id: z.string().uuid(),
  tenant_user_id: z.string().uuid(),
  reason: z.string().min(5).max(500),
  read_only: z.boolean().default(true),
});

export const sessionIdParam = z.object({ id: z.string().uuid() });

export const listQuery = z.object({
  tenant_id: z.string().uuid().optional(),
  platform_user_id: z.string().uuid().optional(),
  active: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
