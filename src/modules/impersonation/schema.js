import { z } from 'zod';

export const startImpersonationSchema = z.object({
  tenant_id: z.string().uuid(),
  tenant_user_id: z.string().uuid(),
  reason: z.string().min(5).max(500),
  read_only: z.boolean().default(true),
});

// One-click entry into a tenant's own admin console. The target user is
// resolved server-side (the tenant's super_admin), so the console only names
// the tenant. A reason is still recorded — it just doesn't have to be typed
// for the common "go look at their setup" case.
export const startTenantAdminSchema = z.object({
  tenant_id: z.string().uuid(),
  reason: z.string().max(500).default('Product-owner support access'),
  read_only: z.boolean().optional(),
});

export const exchangeHandoffSchema = z.object({
  code: z.string().min(20).max(200),
});

export const sessionIdParam = z.object({ id: z.string().uuid() });

export const listQuery = z.object({
  tenant_id: z.string().uuid().optional(),
  platform_user_id: z.string().uuid().optional(),
  active: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
