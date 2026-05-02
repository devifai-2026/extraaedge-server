import { z } from 'zod';

export const listQuery = z.object({
  action: z.string().optional(),
  entity_type: z.string().optional(),
  tenant_id: z.string().uuid().optional(),
  platform_user_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
