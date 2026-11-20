import { z } from 'zod';
import { indianMobileSchema } from '@fos/validation';

/** Request schemas for API-AUTH-* (strict: unknown fields are rejected, DC-03). */

const password = z.string().min(1).max(128);
const newPassword = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128, 'Use at most 128 characters');
const otpCode = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');
const token = z.string().min(20).max(200);
const fullName = z
  .string()
  .trim()
  .min(2, 'Enter your name')
  .max(80)
  .regex(/^[\p{L} .'-]+$/u, "Use letters, spaces and . ' - only");

export const registerBody = z
  .object({
    fullName,
    email: z.email().max(254),
    phone: indianMobileSchema,
    password: newPassword,
    acceptTerms: z.literal(true, { message: 'Please accept the terms and privacy policy' }),
  })
  .strict();

export const loginBody = z
  .object({ identifier: z.string().trim().min(3).max(254), password })
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
    code: otpCode,
    fullName: fullName.optional(),
    acceptTerms: z.boolean().optional(),
  })
  .strict();

export const mfaChallengeBody = z.object({ mfaToken: token, code: otpCode }).strict();
export const logoutAllBody = z.object({ keepCurrent: z.boolean().default(false) }).strict();
export const sessionIdParams = z.object({ sessionId: z.uuid() }).strict();
export const tokenBody = z.object({ token }).strict();
export const phoneVerifyBody = z.object({ code: otpCode }).strict();
export const forgotPasswordBody = z
  .object({ identifier: z.string().trim().min(3).max(254) })
  .strict();

export const resetPasswordBody = z
  .object({
    token: token.optional(),
    phone: indianMobileSchema.optional(),
    code: otpCode.optional(),
    newPassword,
  })
  .strict()
  .refine((b) => Boolean(b.token) !== Boolean(b.phone && b.code), {
    message: 'Provide either a reset link token or a phone number and code',
  });

export const changePasswordBody = z.object({ currentPassword: password, newPassword }).strict();

export const reauthBody = z
  .object({ password: password.optional(), code: otpCode.optional() })
  .strict()
  .refine((b) => (b.password === undefined) !== (b.code === undefined), {
    message: 'Provide your password or a code',
  });

export const deletionBody = z.object({ confirm: z.literal(true) }).strict();
