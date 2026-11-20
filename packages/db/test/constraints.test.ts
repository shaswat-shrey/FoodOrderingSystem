import { PrismaClient, type Prisma } from '@prisma/client';
import { uuidv7 } from '@fos/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDatabase } from '../src/seed/seed';

/**
 * Proves each database-level rule from migration 20261120000200_constraints
 * (docs/database/SCHEMA-NOTES.md) rejects invalid data and accepts valid data.
 * Every case runs in a transaction that is rolled back, except the ledger
 * balance checks which must reach COMMIT (deferred constraint).
 */

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

type Tx = Prisma.TransactionClient;
let prisma: PrismaClient;

class Rollback extends Error {}

/** Runs `fn` in a transaction and always rolls it back. */
async function inRollback(fn: (tx: Tx) => Promise<unknown>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

/** Asserts that `fn` fails with a database error mentioning `rule` (constraint, index or trigger message). */
async function expectRejected(
  rule: string | RegExp,
  fn: (tx: Tx) => Promise<unknown>,
): Promise<void> {
  await expect(inRollback(fn)).rejects.toThrow(rule);
}

/**
 * Asserts a unique-index violation on the given columns. Prisma reports these as
 * P2002 (model calls) or P2010/23505 (raw SQL) without the index name, so each
 * test is built so that only the index under test can be violated.
 */
async function expectUniqueViolation(
  columns: string[],
  fn: (tx: Tx) => Promise<unknown>,
): Promise<void> {
  const error = await inRollback(fn).then(
    () => undefined,
    (e: unknown) =>
      e as { code?: string; meta?: { code?: string; message?: string }; message: string },
  );
  expect(error, 'expected a unique-constraint violation').toBeDefined();
  const isUnique =
    error!.code === 'P2002' || (error!.code === 'P2010' && error!.meta?.code === '23505');
  expect(isUnique, error!.message).toBe(true);
  const text = `${error!.message} ${error!.meta?.message ?? ''}`;
  for (const column of columns) expect(text).toContain(column);
}

const fixtures = {
  ashaId: '',
  rahulId: '',
  branchId: '',
  restaurantId: '',
  foodItemId: '',
  feeScheduleId: '',
  ashaHomeAddressId: '',
  partnerIds: [] as string[],
};

/** Minimal valid order for Asha at the seeded Koramangala biryani branch. */
async function createOrder(tx: Tx) {
  const cart = await tx.cart.create({
    data: { userId: fixtures.ashaId, branchId: fixtures.branchId, status: 'CONVERTED' },
  });
  const session = await tx.checkoutSession.create({
    data: {
      userId: fixtures.ashaId,
      cartId: cart.id,
      cartHash: 'a'.repeat(64),
      addressId: fixtures.ashaHomeAddressId,
      paymentMethod: 'COD',
      quote: {},
      payableAmount: 40000,
      feeScheduleId: fixtures.feeScheduleId,
      status: 'CONFIRMED',
      expiresAt: new Date(Date.now() + 600_000),
    },
  });
  return tx.order.create({
    data: {
      number: `FOS-T${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      userId: fixtures.ashaId,
      restaurantId: fixtures.restaurantId,
      branchId: fixtures.branchId,
      checkoutSessionId: session.id,
      status: 'PLACED',
      paymentMethod: 'COD',
      itemsSubtotalAmount: 32900,
      totalAmount: 40000,
      payableAmount: 40000,
      feeScheduleId: fixtures.feeScheduleId,
      commissionRateBps: 2000,
      contactName: 'Asha Rao',
      contactPhone: '+919000000101',
      items: {
        create: {
          foodItemId: fixtures.foodItemId,
          itemName: 'Chicken Dum Biryani',
          dietaryMarker: 'NON_VEG',
          unitPriceAmount: 32900,
          quantity: 1,
          lineTotalAmount: 32900,
        },
      },
    },
    include: { items: true },
  });
}

async function createDelivery(
  tx: Tx,
  orderId: string,
  status: 'SEARCHING' | 'ASSIGNED' = 'SEARCHING',
  partnerId?: string,
) {
  return tx.delivery.create({
    data: { orderId, branchId: fixtures.branchId, status, partnerId: partnerId ?? null },
  });
}

beforeAll(async () => {
  if (!url) return;
  prisma = new PrismaClient({ datasourceUrl: url });
  await seedDatabase(prisma);
  const asha = await prisma.user.findFirstOrThrow({ where: { phone: '+919000000101' } });
  const rahul = await prisma.user.findFirstOrThrow({ where: { phone: '+919000000102' } });
  const branch = await prisma.branch.findFirstOrThrow({
    where: { name: 'Koramangala', restaurant: { slug: 'saffron-handi-biryani' } },
    select: { id: true, restaurantId: true },
  });
  const item = await prisma.foodItem.findFirstOrThrow({ where: { name: 'Chicken Dum Biryani' } });
  const [address] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM customer_addresses WHERE user_id = ${asha.id}::uuid AND label = 'HOME'`;
  Object.assign(fixtures, {
    ashaId: asha.id,
    rahulId: rahul.id,
    branchId: branch.id,
    restaurantId: branch.restaurantId,
    foodItemId: item.id,
    feeScheduleId: (await prisma.feeSchedule.findFirstOrThrow()).id,
    ashaHomeAddressId: address!.id,
    partnerIds: (
      await prisma.deliveryPartner.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } })
    ).map((p) => p.id),
  });
});

afterAll(async () => {
  await prisma?.$disconnect();
});

suite('seed', () => {
  it('loads the pilot-city dataset', async () => {
    expect(await prisma.restaurant.count()).toBe(8);
    expect(await prisma.branch.count()).toBe(10);
    expect(await prisma.deliveryPartner.count({ where: { onboardingStatus: 'APPROVED' } })).toBe(6);
    expect(await prisma.role.count()).toBe(6);
  });

  it('is repeatable: running it again yields identical counts', async () => {
    const before = await prisma.foodItem.count();
    await seedDatabase(prisma);
    expect(await prisma.foodItem.count()).toBe(before);
    // Re-read fixture ids changed by the reset.
    const asha = await prisma.user.findFirstOrThrow({ where: { phone: '+919000000101' } });
    const rahul = await prisma.user.findFirstOrThrow({ where: { phone: '+919000000102' } });
    const branch = await prisma.branch.findFirstOrThrow({
      where: { name: 'Koramangala', restaurant: { slug: 'saffron-handi-biryani' } },
      select: { id: true, restaurantId: true },
    });
    const [address] = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM customer_addresses WHERE user_id = ${asha.id}::uuid AND label = 'HOME'`;
    Object.assign(fixtures, {
      ashaId: asha.id,
      rahulId: rahul.id,
      branchId: branch.id,
      restaurantId: branch.restaurantId,
      foodItemId: (
        await prisma.foodItem.findFirstOrThrow({ where: { name: 'Chicken Dum Biryani' } })
      ).id,
      feeScheduleId: (await prisma.feeSchedule.findFirstOrThrow()).id,
      ashaHomeAddressId: address!.id,
      partnerIds: (
        await prisma.deliveryPartner.findMany({
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        })
      ).map((p) => p.id),
    });
  });
});

suite('identity (BR-AUTH-014, FR-AUTH-022)', () => {
  it('rejects a second account with the same phone, but allows reuse after anonymisation', async () => {
    await expectUniqueViolation(
      ['phone'],
      (tx) =>
        tx.$executeRaw`INSERT INTO users (id, phone, full_name, updated_at) VALUES (${uuidv7()}::uuid, '+919000000101', 'Dup', now())`,
    );
    await inRollback(async (tx) => {
      await tx.$executeRaw`UPDATE users SET status = 'ANONYMIZED' WHERE id = ${fixtures.ashaId}::uuid`;
      await tx.$executeRaw`INSERT INTO users (id, phone, full_name, updated_at) VALUES (${uuidv7()}::uuid, '+919000000101', 'New owner of number', now())`;
    });
  });

  it('requires an email or a phone and a valid E.164 phone', async () => {
    await expectRejected(
      'users_contact_present_chk',
      (tx) =>
        tx.$executeRaw`INSERT INTO users (id, full_name, updated_at) VALUES (${uuidv7()}::uuid, 'Nobody', now())`,
    );
    await expectRejected(
      'users_phone_e164_chk',
      (tx) =>
        tx.$executeRaw`INSERT INTO users (id, phone, full_name, updated_at) VALUES (${uuidv7()}::uuid, '98765', 'Bad', now())`,
    );
  });

  it('allows only one ACTIVE refresh token per session', async () => {
    await expectUniqueViolation(['session_id'], async (tx) => {
      const session = await tx.userSession.create({
        data: {
          userId: fixtures.ashaId,
          app: 'CUSTOMER',
          idleExpiresAt: new Date(Date.now() + 1e6),
          absoluteExpiresAt: new Date(Date.now() + 1e7),
        },
      });
      const base = { sessionId: session.id, expiresAt: new Date(Date.now() + 1e7) };
      await tx.refreshToken.create({ data: { ...base, tokenHash: Buffer.from('a'.repeat(32)) } });
      await tx.refreshToken.create({ data: { ...base, tokenHash: Buffer.from('b'.repeat(32)) } });
    });
  });
});

suite('geo & restaurants', () => {
  it('rejects an ACTIVE zone that overlaps another (FR-ADMIN-070)', async () => {
    await expectRejected(
      'overlaps another active zone',
      (tx) =>
        tx.$executeRaw`INSERT INTO zones (id, name, city, polygon, updated_at) VALUES (${uuidv7()}::uuid, 'Overlap', 'Bengaluru',
        ST_GeogFromText('SRID=4326;POLYGON((77.63 12.92, 77.65 12.92, 77.65 12.94, 77.63 12.94, 77.63 12.92))'), now())`,
    );
  });

  it('allows an overlapping zone if it is not ACTIVE', async () => {
    await inRollback(
      (tx) =>
        tx.$executeRaw`INSERT INTO zones (id, name, city, polygon, status, updated_at) VALUES (${uuidv7()}::uuid, 'Draft', 'Bengaluru',
        ST_GeogFromText('SRID=4326;POLYGON((77.63 12.92, 77.65 12.92, 77.65 12.94, 77.63 12.94, 77.63 12.92))'), 'INACTIVE', now())`,
    );
  });

  it('limits operating hours to 3 slots per weekday (BR-REST-003)', async () => {
    await expectRejected('at most 3 operating slots', async (tx) => {
      for (const [opens, closes] of [
        ['06:00', '07:00'],
        ['07:30', '08:00'],
        ['08:30', '09:00'],
      ]) {
        await tx.branchOperatingHour.create({
          data: {
            branchId: fixtures.branchId,
            weekday: 1,
            opensAt: new Date(`1970-01-01T${opens}:00Z`),
            closesAt: new Date(`1970-01-01T${closes}:00Z`),
          },
        });
      }
    });
  });

  it('enforces delivery radius bounds and a single active owner per restaurant', async () => {
    await expectRejected(
      'branches_radius_chk',
      (tx) =>
        tx.$executeRaw`UPDATE branches SET delivery_radius_m = 20000 WHERE id = ${fixtures.branchId}::uuid`,
    );
    await expectRejected('restaurant_members_one_owner_uq', (tx) =>
      tx.restaurantMember.create({
        data: { restaurantId: fixtures.restaurantId, userId: fixtures.rahulId, role: 'OWNER' },
      }),
    );
  });

  it('keeps search vectors up to date via trigger', async () => {
    await inRollback(async (tx) => {
      await tx.foodItem.update({
        where: { id: fixtures.foodItemId },
        data: { name: 'Hyderabadi Kacchi Biryani' },
      });
      const [row] = await tx.$queryRaw<{ hit: boolean }[]>`
        SELECT search_vector @@ plainto_tsquery('simple', 'kacchi') AS hit FROM food_items WHERE id = ${fixtures.foodItemId}::uuid`;
      expect(row?.hit).toBe(true);
    });
  });
});

suite('menu (BR-MENU-002..005)', () => {
  it('rejects prices outside ₹1–₹1,00,000 and discounts not below the price', async () => {
    await expectRejected('food_items_price_chk', (tx) =>
      tx.foodItem.update({ where: { id: fixtures.foodItemId }, data: { basePriceAmount: 50 } }),
    );
    await expectRejected('food_items_discount_chk', (tx) =>
      tx.foodItem.update({
        where: { id: fixtures.foodItemId },
        data: { discountedPriceAmount: 32900 },
      }),
    );
  });

  it('allows only one default variant per item', async () => {
    await expectRejected('food_item_variants_one_default_uq', (tx) =>
      tx.foodItemVariant.create({
        data: {
          foodItemId: fixtures.foodItemId,
          name: 'Another default',
          priceAmount: 10000,
          isDefault: true,
        },
      }),
    );
  });

  it('rejects impossible customization selection rules', async () => {
    await expectRejected('customization_groups_selection_chk', (tx) =>
      tx.customizationGroup.create({
        data: { restaurantId: fixtures.restaurantId, name: 'Broken', minSelect: 3, maxSelect: 2 },
      }),
    );
  });
});

suite('cart & coupons (BR-CART-001, BR-COUPON-003/004)', () => {
  it('allows one ACTIVE cart per user', async () => {
    await expectRejected('carts_one_active_per_user_uq', async (tx) => {
      await tx.cart.create({ data: { userId: fixtures.rahulId } });
      await tx.cart.create({ data: { userId: fixtures.rahulId } });
    });
  });

  it('never lets reservations plus redemptions exceed the usage limit', async () => {
    await expectRejected('coupons_limit_chk', async (tx) => {
      const c = await tx.coupon.create({
        data: {
          code: 'LIMIT1',
          description: 't',
          discountType: 'FLAT',
          value: 5000,
          usageLimitTotal: 1,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 1e8),
        },
      });
      await tx.coupon.update({ where: { id: c.id }, data: { reservedCount: 1 } });
      await tx.coupon.update({ where: { id: c.id }, data: { usedCount: 1 } });
    });
  });

  it('requires a cap on percentage coupons', async () => {
    await expectRejected('coupons_percent_chk', (tx) =>
      tx.coupon.create({
        data: {
          code: 'NOCAP',
          description: 't',
          discountType: 'PERCENT',
          value: 2000,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 1e8),
        },
      }),
    );
  });
});

suite('orders & payments (SRS §15.6, FR-PAY-008, FR-REFUND-003)', () => {
  it('keeps payable = total − wallet applied', async () => {
    await expectRejected('orders_payable_chk', async (tx) => {
      const order = await createOrder(tx);
      await tx.order.update({ where: { id: order.id }, data: { walletAppliedAmount: 1000 } });
    });
  });

  it('makes order item snapshots append-only, with an UPDATE-only redaction escape hatch', async () => {
    await expectRejected('append-only', async (tx) => {
      const order = await createOrder(tx);
      await tx.orderItem.update({
        where: { id: order.items[0]!.id },
        data: { itemName: 'Changed later' },
      });
    });
    await expectRejected('append-only', async (tx) => {
      const order = await createOrder(tx);
      await tx.orderItem.delete({ where: { id: order.items[0]!.id } });
    });
    await inRollback(async (tx) => {
      const order = await createOrder(tx);
      await tx.$executeRaw`SET LOCAL fos.allow_redaction = 'on'`;
      await tx.orderItem.update({
        where: { id: order.items[0]!.id },
        data: { instructions: null },
      });
    });
  });

  it('DB-CONV-007: optional references restrict deletes instead of nulling history', async () => {
    // Postgres raises SQLSTATE 23001 (restrict_violation); Prisma surfaces it as an
    // unknown request error carrying the constraint name, not as P2003.
    await expectRejected('orders_coupon_id_fkey', async (tx) => {
      const order = await createOrder(tx);
      const coupon = await tx.coupon.create({
        data: {
          code: 'HIST1',
          description: 't',
          discountType: 'FLAT',
          value: 5000,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 1e8),
        },
      });
      await tx.order.update({ where: { id: order.id }, data: { couponId: coupon.id } });
      await tx.coupon.delete({ where: { id: coupon.id } });
    });
  });

  it('never refunds more than was captured', async () => {
    await expectRejected('payments_refund_bound_chk', async (tx) => {
      const order = await createOrder(tx);
      await tx.payment.create({
        data: {
          orderId: order.id,
          method: 'ONLINE',
          provider: 'MOCK',
          amount: 40000,
          capturedAmount: 40000,
          refundedAmount: 40001,
          status: 'CAPTURED',
        },
      });
    });
  });
});

suite('ledger (DB-INT-004, ADR-011)', () => {
  async function accounts() {
    const [gateway, revenue] = await Promise.all([
      prisma.ledgerAccount.findFirstOrThrow({ where: { type: 'GATEWAY_CLEARING' } }),
      prisma.ledgerAccount.findFirstOrThrow({ where: { type: 'PLATFORM_REVENUE_FEES' } }),
    ]);
    return { gateway, revenue };
  }

  it('rejects an unbalanced journal transaction at commit', async () => {
    const { gateway, revenue } = await accounts();
    await expect(
      prisma.$transaction(async (tx) => {
        const t = await tx.ledgerTransaction.create({
          data: {
            type: 'ADJUSTMENT',
            referenceType: 'TEST',
            referenceId: uuidv7(),
            description: 'unbalanced',
          },
        });
        await tx.ledgerEntry.createMany({
          data: [
            { transactionId: t.id, accountId: gateway.id, amount: 500n },
            { transactionId: t.id, accountId: revenue.id, amount: -400n },
          ],
        });
      }),
    ).rejects.toThrow(/unbalanced/);
  });

  it('accepts a balanced transaction and then forbids changing it', async () => {
    const { gateway, revenue } = await accounts();
    const t = await prisma.$transaction(async (tx) => {
      const created = await tx.ledgerTransaction.create({
        data: {
          type: 'ADJUSTMENT',
          referenceType: 'TEST',
          referenceId: uuidv7(),
          description: 'balanced',
        },
      });
      await tx.ledgerEntry.createMany({
        data: [
          { transactionId: created.id, accountId: gateway.id, amount: 500n },
          { transactionId: created.id, accountId: revenue.id, amount: -500n },
        ],
      });
      return created;
    });
    await expect(
      prisma.ledgerEntry.updateMany({ where: { transactionId: t.id }, data: { amount: 1n } }),
    ).rejects.toThrow(/append-only/);
  });

  it('does not let a customer wallet go negative', async () => {
    await expectRejected('ledger_accounts_wallet_non_negative_chk', (tx) =>
      tx.ledgerAccount.updateMany({
        where: { type: 'CUSTOMER_WALLET', ownerId: fixtures.ashaId },
        data: { balance: -1n },
      }),
    );
  });
});

suite('dispatch (FR-DISP-006/007, BR-DEL-014)', () => {
  it('allows exactly one ACCEPTED assignment per delivery', async () => {
    await expectUniqueViolation(['delivery_id'], async (tx) => {
      const order = await createOrder(tx);
      const delivery = await createDelivery(tx, order.id);
      for (const partnerId of fixtures.partnerIds.slice(0, 2)) {
        await tx.deliveryAssignment.create({
          data: {
            deliveryId: delivery.id,
            partnerId,
            round: 1,
            rank: 1,
            score: 9000,
            scoreBreakdown: {},
            distanceToPickupM: 800,
            status: 'ACCEPTED',
            expiresAt: new Date(Date.now() + 30_000),
          },
        });
      }
    });
  });

  it('allows a partner only one open offer at a time', async () => {
    await expectUniqueViolation(['partner_id'], async (tx) => {
      for (let i = 0; i < 2; i += 1) {
        const order = await createOrder(tx);
        const delivery = await createDelivery(tx, order.id);
        await tx.deliveryAssignment.create({
          data: {
            deliveryId: delivery.id,
            partnerId: fixtures.partnerIds[0]!,
            round: 1,
            rank: 1,
            score: 9000,
            scoreBreakdown: {},
            distanceToPickupM: 800,
            expiresAt: new Date(Date.now() + 30_000),
          },
        });
      }
    });
  });

  it('allows a partner only one active delivery (MVP)', async () => {
    await expectUniqueViolation(['partner_id'], async (tx) => {
      for (let i = 0; i < 2; i += 1) {
        const order = await createOrder(tx);
        await createDelivery(tx, order.id, 'ASSIGNED', fixtures.partnerIds[0]!);
      }
    });
  });

  it('requires a partner once a delivery is assigned', async () => {
    await expectRejected('deliveries_assigned_has_partner_chk', async (tx) => {
      const order = await createOrder(tx);
      await createDelivery(tx, order.id, 'ASSIGNED');
    });
  });
});

suite('immutability (SRS §15.6, FR-CFG-002, FR-DISP-013, FR-PAY-004)', () => {
  it('never edits effective-dated fee, tax, commission or pay configuration in place', async () => {
    await expectRejected('append-only', (tx) =>
      tx.feeSchedule.updateMany({ data: { platformFeeAmount: 900 } }),
    );
    await expectRejected('append-only', (tx) => tx.taxRule.updateMany({ data: { rateBps: 1200 } }));
    await expectRejected('append-only', (tx) =>
      tx.commissionPlan.updateMany({ data: { rateBps: 2500 } }),
    );
    await expectRejected('append-only', (tx) =>
      tx.partnerPayPlan.updateMany({ data: { baseAmount: 3000 } }),
    );
  });

  it('freezes dispatch offers once they reach a final state', async () => {
    await expectRejected('is final', async (tx) => {
      const order = await createOrder(tx);
      const delivery = await createDelivery(tx, order.id);
      const offer = await tx.deliveryAssignment.create({
        data: {
          deliveryId: delivery.id,
          partnerId: fixtures.partnerIds[0]!,
          round: 1,
          rank: 1,
          score: 9000,
          scoreBreakdown: {},
          distanceToPickupM: 800,
          expiresAt: new Date(Date.now() + 30_000),
        },
      });
      await tx.deliveryAssignment.update({ where: { id: offer.id }, data: { status: 'REJECTED' } });
      await tx.deliveryAssignment.update({ where: { id: offer.id }, data: { status: 'ACCEPTED' } });
    });
    // OFFERED → ACCEPTED → RELEASED is a valid path.
    await inRollback(async (tx) => {
      const order = await createOrder(tx);
      const delivery = await createDelivery(tx, order.id);
      const offer = await tx.deliveryAssignment.create({
        data: {
          deliveryId: delivery.id,
          partnerId: fixtures.partnerIds[1]!,
          round: 1,
          rank: 1,
          score: 9000,
          scoreBreakdown: {},
          distanceToPickupM: 800,
          expiresAt: new Date(Date.now() + 30_000),
        },
      });
      await tx.deliveryAssignment.update({ where: { id: offer.id }, data: { status: 'ACCEPTED' } });
      await tx.deliveryAssignment.update({ where: { id: offer.id }, data: { status: 'RELEASED' } });
    });
  });

  it('D-1: lets a payment attempt progress but never changes its amount or provider id', async () => {
    const attempt = async (tx: Tx) => {
      const order = await createOrder(tx);
      const payment = await tx.payment.create({
        data: {
          orderId: order.id,
          method: 'ONLINE',
          provider: 'MOCK',
          amount: 40000,
          status: 'PENDING',
        },
      });
      return tx.paymentAttempt.create({ data: { paymentId: payment.id, amount: 40000 } });
    };
    await inRollback(async (tx) => {
      const a = await attempt(tx);
      await tx.paymentAttempt.update({
        where: { id: a.id },
        data: { providerPaymentId: 'pay_1', status: 'AUTHORIZED' },
      });
      await tx.paymentAttempt.update({ where: { id: a.id }, data: { status: 'CAPTURED' } });
    });
    await expectRejected('payment attempt facts are immutable', async (tx) => {
      const a = await attempt(tx);
      await tx.paymentAttempt.update({ where: { id: a.id }, data: { amount: 1 } });
    });
    await expectRejected('payment attempt facts are immutable', async (tx) => {
      const a = await attempt(tx);
      await tx.paymentAttempt.update({ where: { id: a.id }, data: { providerPaymentId: 'pay_1' } });
      await tx.paymentAttempt.update({ where: { id: a.id }, data: { providerPaymentId: 'pay_2' } });
    });
    await expectRejected('cannot be deleted', async (tx) => {
      const a = await attempt(tx);
      await tx.paymentAttempt.delete({ where: { id: a.id } });
    });
  });

  it('lets webhook processing status change but never the received payload', async () => {
    await inRollback(async (tx) => {
      const event = await tx.paymentWebhookEvent.create({
        data: {
          provider: 'MOCK',
          eventId: 'evt_1',
          eventType: 'payment.captured',
          signatureValid: true,
          payload: { a: 1 },
        },
      });
      await tx.paymentWebhookEvent.update({
        where: { id: event.id },
        data: { processingStatus: 'PROCESSED', processedAt: new Date() },
      });
    });
    await expectRejected('payload is immutable', async (tx) => {
      const event = await tx.paymentWebhookEvent.create({
        data: {
          provider: 'MOCK',
          eventId: 'evt_2',
          eventType: 'payment.captured',
          signatureValid: true,
          payload: { a: 1 },
        },
      });
      await tx.paymentWebhookEvent.update({ where: { id: event.id }, data: { payload: { a: 2 } } });
    });
  });
});

suite('reviews, audit, approvals', () => {
  it('requires the target id that matches the review type, one review per target', async () => {
    await expectRejected('reviews_target_chk', async (tx) => {
      const order = await createOrder(tx);
      await tx.review.create({
        data: {
          orderId: order.id,
          authorId: fixtures.ashaId,
          targetType: 'PARTNER',
          rating: 5,
          editableUntil: new Date(),
        },
      });
    });
    await expectUniqueViolation(['order_id', 'target_type', 'food_item_id'], async (tx) => {
      const order = await createOrder(tx);
      const base = {
        orderId: order.id,
        authorId: fixtures.ashaId,
        targetType: 'RESTAURANT' as const,
        restaurantId: fixtures.restaurantId,
        branchId: fixtures.branchId,
        rating: 4,
        editableUntil: new Date(),
      };
      await tx.review.create({ data: base });
      await tx.review.create({ data: { ...base, rating: 1 } });
    });
  });

  it('makes the audit log append-only even with the redaction setting', async () => {
    await expectRejected('append-only', async (tx) => {
      const log = await tx.auditLog.create({ data: { action: 'test.action', targetType: 'test' } });
      await tx.auditLog.delete({ where: { id: log.id } });
    });
    await expectRejected('append-only', async (tx) => {
      const log = await tx.auditLog.create({ data: { action: 'test.action', targetType: 'test' } });
      await tx.$executeRaw`SET LOCAL fos.allow_redaction = 'on'`;
      await tx.auditLog.delete({ where: { id: log.id } });
    });
  });

  it('prevents the maker from approving their own request (BR-ADMIN-001)', async () => {
    await expectRejected('approval_requests_maker_checker_chk', (tx) =>
      tx.approvalRequest.create({
        data: {
          action: 'fees.update',
          payload: {},
          reason: 'test',
          requestedBy: fixtures.ashaId,
          decidedBy: fixtures.ashaId,
          status: 'APPROVED',
        },
      }),
    );
  });
});
