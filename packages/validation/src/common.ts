import { z } from 'zod';
import { CLIENT_APPS } from '@fos/shared';

/** UUID (we generate UUIDv7, but accept any RFC 4122 UUID from clients). */
export const idSchema = z.uuid();

export const clientAppSchema = z.enum(CLIENT_APPS);

/** Indian mobile number in E.164 form (+91 followed by 10 digits starting 6–9). MVP is India-only. */
export const indianMobileSchema = z
  .string()
  .trim()
  .regex(/^\+91[6-9]\d{9}$/, 'Enter a valid Indian mobile number in +91XXXXXXXXXX format');

/** Integer minor units (paise), non-negative. */
export const amountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Cursor pagination (DC-09, SRS §14.1). */
export const cursorPaginationSchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/** Offset pagination for admin tables. */
export const offsetPaginationSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

/** Idempotency-Key header value (FR-ORDER-002). */
export const idempotencyKeySchema = z.uuid();
