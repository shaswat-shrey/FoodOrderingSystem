import { z } from 'zod';
import { fullNameSchema, otpCodeSchema } from './auth';
import { idSchema, indianMobileSchema } from './common';

/** Mirrors the database enums (packages/db identity/menu schema). */
export const DIETARY_TAGS = [
  'VEGAN',
  'JAIN',
  'GLUTEN_FREE',
  'DAIRY_FREE',
  'SPICY',
  'KETO',
  'HIGH_PROTEIN',
] as const;
export const ALLERGENS = [
  'GLUTEN',
  'CRUSTACEANS',
  'EGGS',
  'FISH',
  'PEANUTS',
  'SOY',
  'MILK',
  'TREE_NUTS',
  'CELERY',
  'MUSTARD',
  'SESAME',
  'SULPHITES',
  'LUPIN',
  'MOLLUSCS',
] as const;
/** English only at launch (SRS A-01); Hindi is added with its translations. */
export const LOCALES = ['en-IN'] as const;

export const updateProfileBody = z
  .object({ fullName: fullNameSchema.optional(), locale: z.enum(LOCALES).optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

export const updatePreferencesBody = z
  .object({
    vegOnlyDefault: z.boolean().optional(),
    dietaryTags: z.array(z.enum(DIETARY_TAGS)).max(DIETARY_TAGS.length).optional(),
    allergens: z.array(z.enum(ALLERGENS)).max(ALLERGENS.length).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

export const changeEmailBody = z
  .object({ email: z.email('Enter a valid email address').max(254) })
  .strict();
export const changePhoneBody = z.object({ phone: indianMobileSchema }).strict();
export const confirmPhoneChangeBody = z
  .object({ phone: indianMobileSchema, code: otpCodeSchema })
  .strict();
export const acceptConsentBody = z.object({ legalDocumentId: idSchema }).strict();

const point = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
  .strict();

const addressFields = {
  label: z.enum(['HOME', 'WORK', 'OTHER']),
  customLabel: z.string().trim().min(1).max(40).optional(),
  line1: z.string().trim().min(1, 'Enter house / flat number').max(200),
  line2: z.string().trim().max(200).optional(),
  landmark: z.string().trim().max(120).optional(),
  area: z.string().trim().min(2, 'Enter the area').max(120),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  pincode: z
    .string()
    .trim()
    .regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code'),
  /** BR-ADDR-002: the map pin is required and authoritative (FR-LOC-004). */
  location: point,
  contactName: fullNameSchema.optional(),
  contactPhone: indianMobileSchema.optional(),
  instructions: z.string().trim().max(200).optional(),
};

/** FR-ADDR-001 */
export const createAddressBody = z
  .object({ ...addressFields, isDefault: z.boolean().optional() })
  .strict();

/** FR-ADDR-003: any subset of fields. */
export const updateAddressBody = z
  .object(addressFields)
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

export const addressIdParams = z.object({ id: idSchema }).strict();
export const listAddressesQuery = z.object({ branchId: idSchema.optional() }).strict();

export type CreateAddressBody = z.infer<typeof createAddressBody>;
export type UpdateAddressBody = z.infer<typeof updateAddressBody>;
