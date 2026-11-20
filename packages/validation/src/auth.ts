import { z } from 'zod';
import { indianMobileSchema } from './common';

/**
 * Request schemas for API-AUTH-* — used by the API for validation and by the
 * web apps for forms, so both enforce identical rules (strict: unknown fields
 * are rejected, DC-03).
 */

export const passwordSchema = z.string().min(1, 'Enter your password').max(128);
export const newPasswordSchema = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128, 'Use at most 128 characters');
export const otpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');
const tokenSchema = z.string().min(20).max(200);
export const fullNameSchema = z
  .string()
  .trim()
  .min(2, 'Enter your name')
  .max(80)
  .regex(/^[\p{L} .'-]+$/u, "Use letters, spaces and . ' - only");
export const identifierSchema = z
  .string()
  .trim()
  .min(3, 'Enter your email or phone number')
  .max(254);

export const registerBody = z
  .object({
    fullName: fullNameSchema,
    email: z.email('Enter a valid email address').max(254),
    phone: indianMobileSchema,
    password: newPasswordSchema,
    acceptTerms: z.literal(true, { message: 'Please accept the terms and privacy policy' }),
  })
  .strict();

export const loginBody = z
  .object({ identifier: identifierSchema, password: passwordSchema })
  .strict();

export const otpRequestBody = z
  .object({
    phone: indianMobileSchema.optional(),
    purpose: z.enum(['LOGIN', 'RESET_PASSWORD', 'VERIFY_PHONE', 'DELETE_ACCOUNT']),
  })
  .strict();

export const otpLoginBody = z
  .object({
    phone: indianMobileSchema,
    code: otpCodeSchema,
    fullName: fullNameSchema.optional(),
    acceptTerms: z.boolean().optional(),
  })
  .strict();

export const mfaChallengeBody = z.object({ mfaToken: tokenSchema, code: otpCodeSchema }).strict();
export const logoutAllBody = z.object({ keepCurrent: z.boolean().default(false) }).strict();
export const sessionIdParams = z.object({ sessionId: z.uuid() }).strict();
export const tokenBody = z.object({ token: tokenSchema }).strict();
export const phoneVerifyBody = z.object({ code: otpCodeSchema }).strict();
export const forgotPasswordBody = z.object({ identifier: identifierSchema }).strict();

export const resetPasswordBody = z
  .object({
    token: tokenSchema.optional(),
    phone: indianMobileSchema.optional(),
    code: otpCodeSchema.optional(),
    newPassword: newPasswordSchema,
  })
  .strict()
  .refine((b) => Boolean(b.token) !== Boolean(b.phone && b.code), {
    message: 'Provide either a reset link token or a phone number and code',
  });

export const changePasswordBody = z
  .object({ currentPassword: passwordSchema, newPassword: newPasswordSchema })
  .strict();

export const reauthBody = z
  .object({ password: passwordSchema.optional(), code: otpCodeSchema.optional() })
  .strict()
  .refine((b) => (b.password === undefined) !== (b.code === undefined), {
    message: 'Provide your password or a code',
  });

export const deletionBody = z.object({ confirm: z.literal(true) }).strict();

export type RegisterBody = z.infer<typeof registerBody>;
export type LoginBody = z.infer<typeof loginBody>;
export type OtpLoginBody = z.infer<typeof otpLoginBody>;
export type ResetPasswordBody = z.infer<typeof resetPasswordBody>;
