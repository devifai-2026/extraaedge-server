import { z } from 'zod';
import { LEAD_ORIGINS } from '../../lib/leadOrigin.js';

export const createPoolSchema = z.object({
  name: z.string().min(1).max(80),
  // At least one origin — a pool that claims no channel can never match, so
  // saving one is always a mistake.
  origins: z.array(z.enum(LEAD_ORIGINS)).min(1),
  // Empty is allowed: an admin may create the pool and pick names after. The
  // resolver skips a pool with no eligible member and falls through.
  member_ids: z.array(z.string().uuid()).default([]),
  strategy: z.enum(['load_balanced', 'round_robin']).default('load_balanced'),
  priority: z.coerce.number().int().min(1).max(10000).default(100),
  is_active: z.boolean().default(true),
});

export const updatePoolSchema = createPoolSchema.partial();

export const idParam = z.object({ id: z.string().uuid() });

export const knownOrigins = LEAD_ORIGINS;
