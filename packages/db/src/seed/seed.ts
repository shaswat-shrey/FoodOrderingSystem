import { Prisma, type PrismaClient } from '@prisma/client';
import {
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLE_GRANTS,
  PLATFORM_ROLES,
  RESTAURANT_PERMISSIONS,
  uuidv7,
  type PlatformRole,
} from '@fos/shared';
import {
  COUPONS,
  CUISINES,
  CUSTOMERS,
  FEATURE_FLAGS,
  FEE_SCHEDULE,
  PARTNERS,
  PAY_PLAN,
  PLATFORM_LEDGER_ACCOUNTS,
  RESTAURANT_STAFF,
  RESTAURANTS,
  SETTINGS,
  STAFF_USERS,
  TAX_RULES,
  ZONES,
  type LngLat,
  type ZoneKey,
} from './data';

type Tx = Prisma.TransactionClient;

export interface SeedSummary {
  zones: number;
  restaurants: number;
  branches: number;
  foodItems: number;
  users: number;
  partners: number;
  coupons: number;
}

const point = ([lng, lat]: LngLat) => `SRID=4326;POINT(${lng} ${lat})`;
const polygon = (ring: readonly LngLat[]) =>
  `SRID=4326;POLYGON((${ring.map(([lng, lat]) => `${lng} ${lat}`).join(', ')}))`;
const timeOfDay = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
const EPOCH = new Date('2026-01-01T00:00:00.000Z');
const FAR_FUTURE = new Date('2027-12-31T23:59:59.000Z');

/** Removes all data (keeps the migration history and PostGIS reference tables). */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'spatial_ref_sys')`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  // Identifiers come from pg_tables, not user input; TRUNCATE cannot take bind parameters.
  await prisma.$executeRaw(Prisma.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
}

async function createUser(
  tx: Tx,
  input: {
    fullName: string;
    phone: string;
    email?: string | null;
    roles: PlatformRole[];
    roleIds: Map<string, string>;
  },
): Promise<string> {
  const user = await tx.user.create({
    data: {
      fullName: input.fullName,
      phone: input.phone,
      email: input.email ?? null,
      status: 'ACTIVE',
      phoneVerifiedAt: EPOCH,
      emailVerifiedAt: input.email ? EPOCH : null,
      roles: { create: input.roles.map((r) => ({ roleId: input.roleIds.get(r)! })) },
    },
  });
  return user.id;
}

async function seedAccessControl(tx: Tx): Promise<Map<string, string>> {
  const permissionIds = new Map<string, string>();
  for (const [key, description] of Object.entries(PLATFORM_PERMISSIONS)) {
    const p = await tx.permission.create({ data: { key, description, scopeType: 'PLATFORM' } });
    permissionIds.set(key, p.id);
  }
  for (const [key, description] of Object.entries(RESTAURANT_PERMISSIONS)) {
    await tx.permission.create({ data: { key, description, scopeType: 'RESTAURANT' } });
  }
  const roleIds = new Map<string, string>();
  for (const key of PLATFORM_ROLES) {
    const role = await tx.role.create({
      data: {
        key,
        name: key
          .replace(/_/g, ' ')
          .toLowerCase()
          .replace(/\b\w/g, (c) => c.toUpperCase()),
        isSystem: true,
        appScope:
          key === 'CUSTOMER'
            ? 'CUSTOMER'
            : key === 'RESTAURANT_OWNER'
              ? 'RESTAURANT'
              : key === 'DELIVERY_PARTNER'
                ? 'DELIVERY'
                : 'ADMIN',
        permissions: {
          create: PLATFORM_ROLE_GRANTS[key].map((p) => ({ permissionId: permissionIds.get(p)! })),
        },
      },
    });
    roleIds.set(key, role.id);
  }
  return roleIds;
}

async function seedPlatformConfig(tx: Tx): Promise<void> {
  for (const [key, value] of Object.entries(SETTINGS)) {
    await tx.platformSetting.create({ data: { key, value: value as Prisma.InputJsonValue } });
  }
  for (const flag of FEATURE_FLAGS) await tx.featureFlag.create({ data: { ...flag } });

  await tx.legalDocument.createMany({
    data: [
      {
        type: 'TERMS',
        version: '1.0',
        content: 'Placeholder terms of use — pending legal review (SRS §20.4).',
        isMaterial: true,
        publishedAt: EPOCH,
      },
      {
        type: 'PRIVACY',
        version: '1.0',
        content: 'Placeholder privacy notice — pending legal review (SRS §20.4).',
        isMaterial: true,
        publishedAt: EPOCH,
      },
    ],
  });

  await tx.feeSchedule.create({
    data: {
      platformFeeAmount: FEE_SCHEDULE.platformFeeAmount,
      smallOrderThresholdAmount: FEE_SCHEDULE.smallOrderThresholdAmount,
      smallOrderFeeAmount: FEE_SCHEDULE.smallOrderFeeAmount,
      perKmBeyondSlabsAmount: FEE_SCHEDULE.perKmBeyondSlabsAmount,
      packagingCapPerItemAmount: FEE_SCHEDULE.packagingCapPerItemAmount,
      packagingCapPerOrderAmount: FEE_SCHEDULE.packagingCapPerOrderAmount,
      surgeCapAmount: FEE_SCHEDULE.surgeCapAmount,
      effectiveFrom: EPOCH,
      deliverySlabs: { create: FEE_SCHEDULE.slabs },
    },
  });
  for (const rule of TAX_RULES) {
    await tx.taxRule.create({ data: { ...rule, taxCode: 'GST', effectiveFrom: EPOCH } });
  }
  await tx.commissionPlan.create({
    data: { name: 'Default', rateBps: 2000, effectiveFrom: EPOCH },
  });
  await tx.partnerPayPlan.create({ data: { ...PAY_PLAN, effectiveFrom: EPOCH } });
  for (const type of PLATFORM_LEDGER_ACCOUNTS) {
    await tx.ledgerAccount.create({ data: { ownerType: 'PLATFORM', type } });
  }
}

async function seedZones(tx: Tx): Promise<Map<ZoneKey, string>> {
  const ids = new Map<ZoneKey, string>();
  for (const zone of ZONES) {
    const id = uuidv7();
    await tx.$executeRaw`
      INSERT INTO zones (id, name, city, polygon, status, updated_at)
      VALUES (${id}::uuid, ${zone.name}, ${zone.city}, ST_GeogFromText(${polygon(zone.ring)}), 'ACTIVE', now())`;
    ids.set(zone.key, id);
  }
  return ids;
}

async function seedCustomers(
  tx: Tx,
  roleIds: Map<string, string>,
  terms: string[],
): Promise<number> {
  for (const c of CUSTOMERS) {
    const userId = await createUser(tx, { ...c, roles: ['CUSTOMER'], roleIds });
    await tx.customerProfile.create({ data: { userId, vegOnlyDefault: c.vegOnly } });
    await tx.userConsent.createMany({
      data: terms.map((legalDocumentId) => ({ userId, legalDocumentId })),
    });
    for (const a of c.addresses) {
      await tx.$executeRaw`
        INSERT INTO customer_addresses (id, user_id, label, line1, line2, area, city, state, pincode, location,
          contact_name, contact_phone, is_default, updated_at)
        VALUES (${uuidv7()}::uuid, ${userId}::uuid, ${a.label}::"AddressLabel", ${a.line1}, ${a.line2}, ${a.area},
          'Bengaluru', 'Karnataka', ${a.pincode}, ST_GeogFromText(${point(a.at)}), ${c.fullName}, ${c.phone},
          ${a.isDefault}, now())`;
    }
    await tx.ledgerAccount.create({
      data: { ownerType: 'CUSTOMER', ownerId: userId, type: 'CUSTOMER_WALLET' },
    });
  }
  return CUSTOMERS.length;
}

async function seedRestaurants(
  tx: Tx,
  roleIds: Map<string, string>,
  zoneIds: Map<ZoneKey, string>,
  cuisineIds: Map<string, string>,
): Promise<{
  restaurants: Map<string, { id: string; branches: Map<string, string> }>;
  branches: number;
  items: number;
}> {
  const restaurants = new Map<string, { id: string; branches: Map<string, string> }>();
  let branchCount = 0;
  let itemCount = 0;

  for (const r of RESTAURANTS) {
    const ownerId = await createUser(tx, { ...r.owner, roles: ['RESTAURANT_OWNER'], roleIds });
    const restaurant = await tx.restaurant.create({
      data: {
        slug: r.slug,
        brandName: r.brandName,
        legalName: r.legalName,
        entityType: r.legalName.includes('Private Limited')
          ? 'PRIVATE_LIMITED'
          : r.legalName.includes('LLP')
            ? 'LLP'
            : 'PROPRIETORSHIP',
        gstin: r.gstin,
        fssaiNumber: r.fssai,
        fssaiExpiresOn: FAR_FUTURE,
        description: r.description,
        contactEmail: r.owner.email,
        contactPhone: r.owner.phone,
        onboardingStatus: 'APPROVED',
        submissionCount: 1,
        pureVeg: r.pureVeg,
        approvedAt: EPOCH,
        cuisines: {
          create: r.cuisines.map((slug, i) => ({
            cuisineId: cuisineIds.get(slug)!,
            isPrimary: i === 0,
            position: i,
          })),
        },
        members: { create: { userId: ownerId, role: 'OWNER', allBranches: true } },
      },
    });
    await tx.ledgerAccount.create({
      data: { ownerType: 'RESTAURANT', ownerId: restaurant.id, type: 'RESTAURANT_PAYABLE' },
    });

    const branchIds = new Map<string, string>();
    for (const b of r.branches) {
      const id = uuidv7();
      await tx.$executeRaw`
        INSERT INTO branches (id, restaurant_id, zone_id, name, line1, area, city, state, pincode, location,
          delivery_radius_m, status, is_open_manual, default_prep_minutes, min_order_amount, price_for_two,
          packaging_fee_mode, packaging_fee_amount, updated_at)
        VALUES (${id}::uuid, ${restaurant.id}::uuid, ${zoneIds.get(b.zone)!}::uuid, ${b.name}, ${b.line1}, ${b.area},
          'Bengaluru', 'Karnataka', ${b.pincode}, ST_GeogFromText(${point(b.at)}), ${b.radiusM}, 'ACTIVE', true,
          ${b.prepMinutes}, ${b.minOrder}, ${b.priceForTwo}, ${b.packaging.mode}::"PackagingFeeMode",
          ${b.packaging.amount}, now())`;
      await tx.branchOperatingHour.createMany({
        data: [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) =>
          b.hours.map(([opens, closes]) => ({
            branchId: id,
            weekday,
            opensAt: timeOfDay(opens),
            closesAt: timeOfDay(closes),
          })),
        ),
      });
      branchIds.set(b.name, id);
      branchCount += 1;
    }

    const categoryIds = new Map<string, string>();
    for (const [position, name] of r.categories.entries()) {
      const c = await tx.menuCategory.create({
        data: { restaurantId: restaurant.id, name, position },
      });
      categoryIds.set(name, c.id);
    }

    const groupIds = new Map<string, string>();
    for (const g of r.groups) {
      const group = await tx.customizationGroup.create({
        data: {
          restaurantId: restaurant.id,
          name: g.name,
          minSelect: g.min,
          maxSelect: g.max,
          options: {
            create: g.options.map((o, position) => ({
              name: o.name,
              priceDeltaAmount: o.price,
              dietaryMarker: o.marker,
              isDefault: o.isDefault ?? false,
              position,
            })),
          },
        },
      });
      groupIds.set(g.key, group.id);
    }

    for (const [position, item] of r.items.entries()) {
      await tx.foodItem.create({
        data: {
          restaurantId: restaurant.id,
          categoryId: categoryIds.get(item.category)!,
          name: item.name,
          description: item.description,
          basePriceAmount: item.price,
          discountedPriceAmount: item.discounted ?? null,
          dietaryMarker: item.marker,
          spiceLevel: item.spice ?? null,
          isBestseller: item.bestseller ?? false,
          isRecommended: item.recommended ?? false,
          isTodaysSpecial: item.special ?? false,
          position,
          tags: { create: (item.tags ?? []).map((tag) => ({ tag })) },
          allergens: { create: (item.allergens ?? []).map((allergen) => ({ allergen })) },
          variants: {
            create: (item.variants ?? []).map((v, i) => ({
              name: v.name,
              priceAmount: v.price,
              isDefault: v.isDefault ?? false,
              position: i,
            })),
          },
          customizationGroups: {
            create: (item.groups ?? []).map((key, i) => ({
              groupId: groupIds.get(key)!,
              position: i,
            })),
          },
        },
      });
      itemCount += 1;
    }
    restaurants.set(r.slug, { id: restaurant.id, branches: branchIds });
  }

  for (const s of RESTAURANT_STAFF) {
    const restaurant = restaurants.get(s.restaurant)!;
    const userId = await createUser(tx, {
      fullName: s.fullName,
      phone: s.phone,
      email: s.email,
      roles: [],
      roleIds,
    });
    await tx.restaurantMember.create({
      data: {
        restaurantId: restaurant.id,
        userId,
        role: s.role,
        allBranches: s.branches === null,
        branches: s.branches
          ? { create: s.branches.map((name) => ({ branchId: restaurant.branches.get(name)! })) }
          : undefined,
      },
    });
  }

  return { restaurants, branches: branchCount, items: itemCount };
}

async function seedPartners(
  tx: Tx,
  roleIds: Map<string, string>,
  zoneIds: Map<ZoneKey, string>,
): Promise<number> {
  for (const p of PARTNERS) {
    const userId = await createUser(tx, {
      fullName: p.fullName,
      phone: p.phone,
      roles: ['DELIVERY_PARTNER'],
      roleIds,
    });
    const partner = await tx.deliveryPartner.create({
      data: {
        userId,
        onboardingStatus: 'APPROVED',
        submissionCount: 1,
        legalName: p.fullName,
        dateOfBirth: new Date('1995-06-15'),
        homeZoneId: zoneIds.get(p.zone)!,
        guidelinesVersionAck: '1.0',
        approvedAt: EPOCH,
        vehicles: {
          create: {
            type: p.vehicle,
            registrationNumber: p.reg,
            status: 'VERIFIED',
            isActive: true,
          },
        },
        stats: { create: {} },
      },
    });
    await tx.$executeRaw`
      UPDATE delivery_partners SET last_location = ST_GeogFromText(${point(p.at)}), last_location_at = now()
      WHERE id = ${partner.id}::uuid`;
    await tx.ledgerAccount.createMany({
      data: [
        { ownerType: 'PARTNER', ownerId: partner.id, type: 'PARTNER_PAYABLE' },
        { ownerType: 'PARTNER', ownerId: partner.id, type: 'PARTNER_CASH_IN_HAND' },
      ],
    });
  }
  return PARTNERS.length;
}

/**
 * Loads the development dataset. Destructive when `reset` is true (default):
 * all tables are truncated first so the result is identical on every run.
 */
export async function seedDatabase(
  prisma: PrismaClient,
  { reset = true } = {},
): Promise<SeedSummary> {
  if (reset) await resetDatabase(prisma);

  return prisma.$transaction(
    async (tx) => {
      const roleIds = await seedAccessControl(tx);
      const zoneIds = await seedZones(tx);
      await seedPlatformConfig(tx);
      const terms = (await tx.legalDocument.findMany({ select: { id: true } })).map((d) => d.id);

      const cuisineIds = new Map<string, string>();
      for (const [slug, name] of CUISINES) {
        const c = await tx.cuisine.create({ data: { slug, name } });
        cuisineIds.set(slug, c.id);
      }

      for (const s of STAFF_USERS) await createUser(tx, { ...s, roles: [...s.roles], roleIds });
      const customers = await seedCustomers(tx, roleIds, terms);
      const { restaurants, branches, items } = await seedRestaurants(
        tx,
        roleIds,
        zoneIds,
        cuisineIds,
      );
      const partners = await seedPartners(tx, roleIds, zoneIds);

      for (const c of COUPONS) {
        await tx.coupon.create({
          data: {
            ...c,
            startsAt: EPOCH,
            endsAt: FAR_FUTURE,
            status: 'ACTIVE',
            visibility: 'PUBLIC',
          },
        });
      }
      await tx.collection.create({
        data: {
          slug: 'featured',
          title: 'Featured this week',
          items: {
            create: [
              'saffron-handi-biryani',
              'banana-leaf-udupi-kitchen',
              'ember-and-crust-pizzeria',
            ].map((slug, position) => ({
              restaurantId: restaurants.get(slug)!.id,
              position,
            })),
          },
        },
      });

      return {
        zones: ZONES.length,
        restaurants: restaurants.size,
        branches,
        foodItems: items,
        users:
          STAFF_USERS.length + customers + RESTAURANTS.length + RESTAURANT_STAFF.length + partners,
        partners,
        coupons: COUPONS.length,
      };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}
