import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenant_slug: z.string().optional(),  // required for tenant users; omitted for platform users
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

// Counsellor recorder app login — the counsellor identifies by the phone
// number saved on their web-portal profile plus the institute code (tenant slug).
export const mobileOtpRequestSchema = z.object({
  tenant_slug: z.string().min(1).max(80),
  phone: z.string().min(10).max(20),
});

export const mobileOtpVerifySchema = mobileOtpRequestSchema.extend({
  otp: z.string().min(4).max(8),
});

// Passwordless web login. `phone` is optional on the request so the client can
// probe an email first: an account with no number on file comes back as
// { needs_phone: true }, and the client re-posts with the number to bind.
export const webOtpRequestSchema = z.object({
  tenant_slug: z.string().min(1).max(80),
  email: z.string().email(),
  phone: z.string().min(10).max(20).optional(),
});

export const webOtpVerifySchema = z.object({
  tenant_slug: z.string().min(1).max(80),
  email: z.string().email(),
  otp: z.string().min(4).max(8),
});

export const loginMethodsQuery = z.object({
  tenant_slug: z.string().min(1).max(80),
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
