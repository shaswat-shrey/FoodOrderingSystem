import type { PrismaClient } from '@fos/db';
import { uuidv7 } from '@fos/shared';
import type { CreateAddressBody, UpdateAddressBody } from '@fos/validation';
import { AppError } from '../../platform/http/errors';
import type { DeliveryInfo, ServiceabilityService } from '../catalog';
import type { SettingsService } from '../config';
import type { GeoService, LatLng } from '../geo';

interface AddressRow {
  id: string;
  label: 'HOME' | 'WORK' | 'OTHER';
  custom_label: string | null;
  line1: string;
  line2: string | null;
  landmark: string | null;
  area: string;
  city: string;
  state: string;
  pincode: string;
  lat: number;
  lng: number;
  contact_name: string;
  contact_phone: string;
  instructions: string | null;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface AddressView {
  id: string;
  label: AddressRow['label'];
  customLabel: string | null;
  line1: string;
  line2: string | null;
  landmark: string | null;
  area: string;
  city: string;
  state: string;
  pincode: string;
  location: LatLng;
  contactName: string;
  contactPhone: string;
  instructions: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** Present when listing for a branch (FR-ADDR-002). */
  serviceability?: {
    serviceable: boolean;
    reason: DeliveryInfo['reason'];
    distanceKm: number | null;
  };
}

const toView = (r: AddressRow): AddressView => ({
  id: r.id,
  label: r.label,
  customLabel: r.custom_label,
  line1: r.line1,
  line2: r.line2,
  landmark: r.landmark,
  area: r.area,
  city: r.city,
  state: r.state,
  pincode: r.pincode,
  location: { lat: Number(r.lat), lng: Number(r.lng) },
  contactName: r.contact_name,
  contactPhone: r.contact_phone,
  instructions: r.instructions,
  isDefault: r.is_default,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const invalid = (path: string, message: string) =>
  new AppError('ADDRESS_INVALID', {
    message,
    details: [{ path, code: 'ADDRESS_INVALID', message }],
  });

const labelTaken = (label: string) =>
  invalid(
    'label',
    `You already have a ${label === 'HOME' ? 'Home' : 'Work'} address. Use “Other” or edit that one.`,
  );

/** Maps the database backstops (BR-ADDR-001, FR-ADDR-005) to friendly errors if a race slips past the checks. */
function mapConstraint(error: unknown, label?: string): never {
  const text = String((error as { message?: unknown })?.message ?? '');
  if (text.includes('customer_addresses_home_work_uq')) throw labelTaken(label ?? 'HOME');
  if (text.includes('customer_addresses_one_default_uq')) {
    throw new AppError('CONFLICT_STALE_VERSION', {
      message: 'Your addresses just changed. Please try again.',
    });
  }
  throw error;
}

/** FR-ADDR-001…006, BR-ADDR-001/002. Every query is scoped to the owner. */
export class AddressService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly geo: GeoService,
    private readonly serviceability: ServiceabilityService,
    private readonly settings: SettingsService,
  ) {}

  private async rows(userId: string, id?: string): Promise<AddressRow[]> {
    return this.prisma.$queryRaw<AddressRow[]>`
      SELECT id, label::text AS label, custom_label, line1, line2, landmark, area, city, state, pincode,
             ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
             contact_name, contact_phone, instructions, is_default, created_at, updated_at
      FROM customer_addresses
      WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
        AND (${id ?? null}::uuid IS NULL OR id = ${id ?? null}::uuid)
      ORDER BY is_default DESC, created_at DESC`;
  }

  async list(userId: string, branchId?: string): Promise<AddressView[]> {
    const views = (await this.rows(userId)).map(toView);
    if (!branchId) return views;
    const branch = await this.serviceability.listedBranch(branchId);
    return Promise.all(
      views.map(async (v) => {
        const [zone, straightLineM] = await Promise.all([
          this.serviceability.zoneAt(v.location),
          this.serviceability.straightLineM(branch.id, v.location),
        ]);
        const info = await this.serviceability.deliveryInfo(
          branch,
          v.location,
          straightLineM,
          zone && zone.status === 'ACTIVE' ? zone.id : null,
        );
        return {
          ...v,
          serviceability: {
            serviceable: info.serviceable,
            reason: info.reason,
            distanceKm: info.distanceKm,
          },
        };
      }),
    );
  }

  async get(userId: string, id: string): Promise<AddressView> {
    const [row] = await this.rows(userId, id);
    if (!row) throw new AppError('NOT_FOUND', { message: "We couldn't find that address." });
    return toView(row);
  }

  async create(userId: string, input: CreateAddressBody): Promise<AddressView> {
    this.geo.assertInIndia(input.location, 'location');
    const existing = await this.rows(userId);
    const max = await this.settings.get('address.maxPerUser');
    if (existing.length >= max)
      throw invalid('label', `You can save up to ${max} addresses. Delete one to add another.`);
    if (input.label !== 'OTHER' && existing.some((a) => a.label === input.label))
      throw labelTaken(input.label);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { fullName: true, phone: true },
    });
    const contactPhone = input.contactPhone ?? user.phone;
    if (!contactPhone)
      throw invalid('contactPhone', 'Add a contact phone number for the delivery partner.');
    const makeDefault = input.isDefault === true || existing.length === 0;

    try {
      const [row] = await this.prisma.$transaction(async (tx) => {
        if (makeDefault) {
          await tx.$executeRaw`UPDATE customer_addresses SET is_default = false, updated_at = now()
            WHERE user_id = ${userId}::uuid AND is_default AND deleted_at IS NULL`;
        }
        return tx.$queryRaw<{ id: string }[]>`
          INSERT INTO customer_addresses (id, user_id, label, custom_label, line1, line2, landmark, area, city, state,
            pincode, location, contact_name, contact_phone, instructions, is_default, updated_at)
          VALUES (${uuidv7()}::uuid, ${userId}::uuid, ${input.label}::"AddressLabel", ${input.customLabel ?? null},
            ${input.line1}, ${input.line2 ?? null}, ${input.landmark ?? null}, ${input.area}, ${input.city},
            ${input.state}, ${input.pincode},
            ST_SetSRID(ST_MakePoint(${input.location.lng}, ${input.location.lat}), 4326)::geography,
            ${input.contactName ?? user.fullName}, ${contactPhone}, ${input.instructions ?? null}, ${makeDefault}, now())
          RETURNING id`;
      });
      return this.get(userId, row!.id);
    } catch (error) {
      mapConstraint(error, input.label);
    }
  }

  async update(userId: string, id: string, patch: UpdateAddressBody): Promise<AddressView> {
    const current = await this.get(userId, id);
    if (patch.location) this.geo.assertInIndia(patch.location, 'location');
    if (patch.label && patch.label !== 'OTHER' && patch.label !== current.label) {
      const others = await this.rows(userId);
      if (others.some((a) => a.id !== id && a.label === patch.label)) throw labelTaken(patch.label);
    }
    const next = { ...current, ...patch, location: patch.location ?? current.location };
    try {
      // Orders keep their own address snapshot, so editing never changes placed orders (FR-ADDR-003).
      await this.prisma.$executeRaw`
        UPDATE customer_addresses SET
          label = ${next.label}::"AddressLabel", custom_label = ${next.customLabel ?? null},
          line1 = ${next.line1}, line2 = ${next.line2 ?? null}, landmark = ${next.landmark ?? null},
          area = ${next.area}, city = ${next.city}, state = ${next.state}, pincode = ${next.pincode},
          location = ST_SetSRID(ST_MakePoint(${next.location.lng}, ${next.location.lat}), 4326)::geography,
          contact_name = ${next.contactName}, contact_phone = ${next.contactPhone},
          instructions = ${next.instructions ?? null}, updated_at = now()
        WHERE id = ${id}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL`;
    } catch (error) {
      mapConstraint(error, patch.label);
    }
    return this.get(userId, id);
  }

  /** FR-ADDR-004: soft delete; a deleted default leaves no default until one is set. */
  async remove(userId: string, id: string): Promise<void> {
    await this.get(userId, id);
    await this.prisma.customerAddress.update({
      where: { id },
      data: { deletedAt: new Date(), isDefault: false },
    });
  }

  /** FR-ADDR-005 */
  async setDefault(userId: string, id: string): Promise<AddressView> {
    await this.get(userId, id);
    try {
      await this.prisma.$transaction([
        this.prisma.$executeRaw`UPDATE customer_addresses SET is_default = false, updated_at = now()
          WHERE user_id = ${userId}::uuid AND is_default AND deleted_at IS NULL AND id <> ${id}::uuid`,
        this.prisma.$executeRaw`UPDATE customer_addresses SET is_default = true, updated_at = now()
          WHERE id = ${id}::uuid AND user_id = ${userId}::uuid`,
      ]);
    } catch (error) {
      mapConstraint(error);
    }
    return this.get(userId, id);
  }
}
