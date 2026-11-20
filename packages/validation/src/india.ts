import { z } from 'zod';

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** GSTIN check character (mod-36 weighted sum, as published by GSTN). */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]!);
    const product = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36]!;
}

const upper = (s: z.ZodString) => s.trim().transform((v) => v.toUpperCase());

export const panSchema = upper(z.string()).pipe(
  z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Enter a valid PAN, like ABCDE1234F'),
);

export const gstinSchema = upper(z.string()).pipe(
  z
    .string()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid 15-character GSTIN')
    .refine((v) => gstinCheckChar(v.slice(0, 14)) === v[14], 'This GSTIN’s check digit is wrong'),
);

export const ifscSchema = upper(z.string()).pipe(
  z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid 11-character IFSC'),
);

export const fssaiSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{14}$/, 'The FSSAI licence number has 14 digits');

export const bankAccountNumberSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{9,18}$/, 'Bank account numbers have 9 to 18 digits');
