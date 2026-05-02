import { z } from 'zod';

export const createProgramSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  description: z.string().optional(),
  category: z.enum(['abroad', 'domestic', 'coaching']).optional(),
  type: z.enum(['online', 'offline', 'hybrid']).optional(),
  price: z.coerce.number().nonnegative().optional(),
  currency: z.string().optional(),
  discount_price: z.coerce.number().nonnegative().optional(),
  duration_value: z.coerce.number().int().nonnegative().optional(),
  duration_unit: z.enum(['days', 'months', 'years']).optional(),
  eligibility: z.string().optional(),
  intake_month: z.string().optional(),
  country: z.string().optional(),
  is_active: z.boolean().optional(),
  is_featured: z.boolean().optional(),
  brochure_url: z.string().url().optional(),
  image_url: z.string().url().optional(),
});

export const updateProgramSchema = createProgramSchema.partial();

export const listQuery = z.object({
  q: z.string().optional(),
  category: z.enum(['abroad', 'domestic', 'coaching']).optional(),
  is_active: z.enum(['true', 'false']).optional(),
  is_featured: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const idParam = z.object({ id: z.string().uuid() });
