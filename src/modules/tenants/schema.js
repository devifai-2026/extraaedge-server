import { z } from 'zod';

export const slugSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/u, 'slug must be lowercase alphanumeric with hyphens');

export const tenantCreateSchema = z.object({
  name: z.string().min(1),
  slug: slugSchema,
  company_name: z.string().optional(),
  brand_name: z.string().optional(),
  logo_url: z.string().url().optional(),
  logo_dark_url: z.string().url().optional(),
  favicon_url: z.string().url().optional(),
  brand_primary_color: z.string().optional(),
  brand_secondary_color: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  website: z.string().url().optional(),
  industry: z.string().optional(),
  country: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  pincode: z.string().optional(),
  timezone: z.string().optional(),
  currency: z.string().optional(),
  default_language: z.string().optional(),
  plan_id: z.string().uuid().optional(),
  billing_email: z.string().email().optional(),
  // 'otp' | 'password' | 'both'. Omitted on create = DB default ('both').
  auth_mode: z.enum(['otp', 'password', 'both']).optional(),
  trial_ends_at: z.coerce.date().optional(),
  subscription_ends_at: z.coerce.date().optional(),
  first_admin: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
    password: z.string().min(10),
  }),
});

export const tenantUpdateSchema = tenantCreateSchema.partial().omit({ slug: true, first_admin: true });

export const tenantBrandingSchema = z.object({
  brand_name: z.string().optional(),
  logo_url: z.string().url().optional(),
  logo_dark_url: z.string().url().optional(),
  favicon_url: z.string().url().optional(),
  brand_primary_color: z.string().optional(),
  brand_secondary_color: z.string().optional(),
});

export const tenantIdParam = z.object({ id: z.string().uuid() });

// How this tenant's users sign in. Mirrors the tenants.auth_mode CHECK.
export const authModeSchema = z.object({
  auth_mode: z.enum(['otp', 'password', 'both']),
});

// Set or rotate the tenant super admin's password.
//
// `password` is optional: omitted, the server generates a strong temporary one
// and returns it once. That is the normal path — it means the product owner
// never has to invent a password, and the value shown is the value stored.
// A supplied password must clear the same 10-char floor as tenant creation.
export const tenantAdminPasswordSchema = z.object({
  password: z.string().min(10).max(200).optional(),
  // Which admin, when a tenant somehow has more than one super_admin. Omitted
  // = the tenant's only/earliest super_admin.
  user_id: z.string().uuid().optional(),
});

export const tenantListQuery = z.object({
  q: z.string().optional(),
  status: z.enum(['provisioning', 'active', 'suspended', 'cancelled']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});
