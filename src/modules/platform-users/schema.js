import { z } from 'zod';
import { PLATFORM_ROLES } from '../../config/constants.js';

export const createPlatformUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  password: z.string().min(10),
  role: z.enum([PLATFORM_ROLES.PRODUCT_OWNER, PLATFORM_ROLES.SUPPORT_ADMIN]),
});

export const updatePlatformUserSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  is_active: z.boolean().optional(),
  role: z.enum([PLATFORM_ROLES.SUPPORT_ADMIN]).optional(),
});

export const platformUserIdParam = z.object({ id: z.string().uuid() });
