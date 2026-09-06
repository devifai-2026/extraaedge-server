import { z } from 'zod';
import { LEAD_ORIGINS } from '../../lib/leadOrigin.js';

const basePoolSchema = z.object({
  name: z.string().min(1).max(80),
  // Built-in acquisition channels, derived from first_touch_* (lib/leadOrigin).
  origins: z.array(z.enum(LEAD_ORIGINS)).default([]),
  // The tenant's OWN source / channel names, matched case-insensitively
  // against first_touch_source and first_touch_channel. This is what lets a
  // pool claim "Social Media" leads, which match no built-in origin.
  source_names: z.array(z.string().min(1).max(120)).max(50).default([]),
  // Empty is allowed: an admin may create the pool and pick names after. The
  // resolver skips a pool with no eligible member and falls through.
  member_ids: z.array(z.string().uuid()).default([]),
  strategy: z.enum(['load_balanced', 'round_robin']).default('load_balanced'),
  priority: z.coerce.number().int().min(1).max(10000).default(100),
  is_active: z.boolean().default(true),
});

// A pool with neither origins nor source_names can never match a lead, so
// saving one is always a mistake — catch it here rather than letting an admin
// wonder why nothing routes.
const hasMatcher = (v) => (v.origins?.length ?? 0) > 0 || (v.source_names?.length ?? 0) > 0;
const MATCHER_MSG = 'Pick at least one channel or source — a rule with none can never match a lead';

export const createPoolSchema = basePoolSchema.refine(hasMatcher, {
  path: ['origins'],
  message: MATCHER_MSG,
});

// On update the client may send only the fields it changed, so the check runs
// only when at least one matcher field is present in the payload.
export const updatePoolSchema = basePoolSchema.partial().refine(
  (v) => (v.origins === undefined && v.source_names === undefined) || hasMatcher(v),
  { path: ['origins'], message: MATCHER_MSG },
);

export const idParam = z.object({ id: z.string().uuid() });

export const knownOrigins = LEAD_ORIGINS;
