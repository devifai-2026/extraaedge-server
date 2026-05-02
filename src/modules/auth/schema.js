import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenant_slug: z.string().optional(),  // required for tenant users; omitted for platform users
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
  tenant_slug: z.string().optional(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  new_password: z.string().min(10),
});

export const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(10),
});
