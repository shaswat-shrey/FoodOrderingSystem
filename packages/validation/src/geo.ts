import { z } from 'zod';
import { idSchema } from './common';

/** WGS-84 coordinates from query strings (strings coerced to numbers). */
export const latSchema = z.coerce.number().min(-90).max(90);
export const lngSchema = z.coerce.number().min(-180).max(180);

export const latLngQuery = z.object({ lat: latSchema, lng: lngSchema }).strict();

/** India-only MVP: 6-digit PIN code not starting with 0 (FR-ADDR-006). */
export const pincodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code');

export const geoAutocompleteQuery = z
  .object({
    q: z.string().trim().min(3, 'Type at least 3 characters').max(100),
    lat: latSchema.optional(),
    lng: lngSchema.optional(),
    sessionToken: z.string().min(8).max(64).optional(),
  })
  .strict();

export const geoPlaceParams = z.object({ placeId: z.string().min(1).max(200) }).strict();

export const serviceabilityQuery = z
  .object({ lat: latSchema, lng: lngSchema, branchId: idSchema.optional() })
  .strict();

export const geocodeBody = z
  .object({
    line1: z.string().trim().max(200).optional(),
    line2: z.string().trim().max(200).optional(),
    area: z.string().trim().min(2).max(120),
    city: z.string().trim().min(2).max(80),
    pincode: pincodeSchema.optional(),
    /** The pin the customer chose; the response says how far the text address is from it. */
    pin: z.object({ lat: latSchema, lng: lngSchema }).strict().optional(),
  })
  .strict();
