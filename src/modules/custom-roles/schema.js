import { z } from 'zod';
import { DEFAULT_TAB_KEYS, SYSTEM_TENANT_ROLES } from '../../config/constants.js';

const permLevel = z.enum(['full', 'read_only', 'hidden']);
const tabPermissions = z.record(z.string(), permLevel);

// Mirror every tenant role bucket — account_manager was missing here,
// which 400'd any attempt to edit the post-enrollment Accounts role.
const ROLE_SCOPES = Object.values(SYSTEM_TENANT_ROLES);

export const createRoleSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().optional(),
  scope: z.enum(ROLE_SCOPES).default('counsellor'),
  tab_permissions: tabPermissions.default({}),
  feature_permissions: z.record(z.string(), z.any()).default({}),
});

export const updateRoleSchema = createRoleSchema.partial().extend({
  is_system: z.boolean().optional(), // ignored by service; set only by seeds
});

export const idParam = z.object({ id: z.string().uuid() });

export const knownTabs = DEFAULT_TAB_KEYS;
