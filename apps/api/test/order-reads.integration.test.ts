import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { uuidv7 } from '@fos/shared';
import { localParts, zonedInstant } from '../src/modules/catalog/local-time';
import { financialYear } from '../src/modules/orders';
import type { MockPaymentProvider } from '../src/modules/payments';
import type { RecordingJobQueue } from '../src/platform/jobs';
import {
  branchId,
  createTestContext,
  integrationEnabled,
  ORIGINS,
  placeOrder,
  signUpCustomer,
  type TestContext,
} from './helpers';

const suite = integrationEnabled ? describe : describe.skip;
let ctx: TestContext;
let mock: MockPaymentProvider;
let saffron: string;
const ids: Record<string, string> = {};

function todayAt(hm: string): Date {
  const [h, m] = hm.split(':').map(Number);
  const t = localParts(new Date(), 'Asia/Kolkata');
  return zonedInstant(t.year, t.month, t.day, h! * 60 + m!, 'Asia/Kolkata');
}
const key = () => ({ 'Idempotency-Key': uuidv7() });

beforeAll(async () => {
  if (!integrationEnabled) return;
  ctx = await createTestContext();
  mock = ctx.container.paymentProvider as MockPaymentProvider;
  saffron = await branchId(ctx, 'Saffron Handi Biryani', 'Koramangala');
  const restaurantId = (await ctx.prisma.branch.findUniqueOrThrow({ where: { id: saffron } }))
    .restaurantId;
  for (const i of await ctx.prisma.foodItem.findMany({ where: { restaurantId } }))
    ids[i.name] = i.id;
  for (const o of await ctx.prisma.customizationOption.findMany({
    where: { group: { restaurantId } },
  }))
    ids[o.name] = o.id;
});
afterAll(async () => {
  if (integrationEnabled) await ctx.close();
});
beforeEach(async () => {
  if (!integrationEnabled) return;
  await Promise.all([ctx.redis.core.flushdb(), ctx.redis.cache.flushdb()]);
  ctx.clock.set(todayAt('13:00'));
  (ctx.container.jobs as RecordingJobQueue).jobs.length = 0;
  await ctx.prisma.outboxEvent.updateMany({
    where: { publishedAt: null },
    data: { publishedAt: new Date() },
  });
});

const lines = () => [
  { foodItemId: ids['Paneer Biryani']!, optionIds: [ids.Mild!, ids['Extra raita']!], quantity: 1 },
];

async function move(orderId: string, path: string[]) {
  const actor: Record<string, 'RESTAURANT' | 'ADMIN'> = { DELIVERED: 'ADMIN' };
  for (const to of path)
    await ctx.prisma.$transaction((tx) =>
      ctx.container.orderTransitions.apply(tx, {
        orderId,
        to: to as 'ACCEPTED',
        actor: { type: actor[to] ?? 'RESTAURANT', id: null },
      }),
    );
}
const TO_DELIVERED = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'DELIVERED'];

suite('order reads (API-ORD-001…005, FR-CORD-001…003)', () => {
  it('lists history newest first with filters and pages, and active orders', async () => {
    const first = await placeOrder(ctx, {
      branchId: saffron,
      items: lines(),
      paymentMethod: 'COD',
    });
    const b = first.browser;
    ctx.clock.advance(60_000);
    // Second order by the same customer.
    await b.post('/cart/items', { branchId: saffron, ...lines()[0] });
    const s = (
      await b.post('/checkout/sessions', { addressId: first.addressId, paymentMethod: 'COD' })
    ).body.data;
    const second = (
      await b.post(
        `/checkout/sessions/${s.id}/confirm`,
        { expectedPayable: s.payableAmount },
        key(),
      )
    ).body.data.order;
    await ctx.container.orderCancellation.cancel({
      orderId: first.orderId,
      actor: { type: 'ADMIN' },
      reasonCode: 'TEST',
      fault: 'PLATFORM',
    });

    const page1 = await b.get('/me/orders', { limit: 1 });
    expect(page1.body.data).toEqual([
      expect.objectContaining({
        id: second.id,
        status: 'PLACED',
        statusLabel: 'Order placed',
        itemsSummary: '1 × Paneer Biryani',
        restaurant: expect.objectContaining({ name: 'Saffron Handi Biryani' }),
      }),
    ]);
    const page2 = await b.get('/me/orders', {
      limit: 1,
      cursor: page1.body.meta.pagination.nextCursor,
    });
    expect(page2.body.data.map((o: { id: string }) => o.id)).toEqual([first.orderId]);
    expect(page2.body.meta.pagination.nextCursor).toBeNull();

    expect(
      (await b.get('/me/orders', { status: 'CANCELLED' })).body.data.map(
        (o: { id: string }) => o.id,
      ),
    ).toEqual([first.orderId]);
    expect((await b.get('/me/orders/active')).body.data.map((o: { id: string }) => o.id)).toEqual([
      second.id,
    ]);
  });

  it('shows the snapshot as charged and hides other customers’ orders', async () => {
    const c = await placeOrder(ctx, {
      branchId: saffron,
      items: lines(),
      paymentMethod: 'COD',
      tipAmount: 2_000,
    });
    const res = await c.browser.get(`/orders/${c.orderId}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.items).toEqual([
      expect.objectContaining({
        itemName: 'Paneer Biryani',
        unitPriceAmount: 27_900,
        optionsAmount: 3_000,
        options: expect.arrayContaining([
          expect.objectContaining({ optionName: 'Extra raita', priceDeltaAmount: 3_000 }),
        ]),
      }),
    ]);
    expect(d.breakdown).toMatchObject({ tip: 2_000, total: c.session.quote.total });
    expect(d.address).toMatchObject({ area: 'Koramangala', pincode: '560095' });
    expect(d.timeline).toEqual([expect.objectContaining({ status: 'PLACED', by: 'CUSTOMER' })]);
    expect(d).toMatchObject({ invoiceAvailable: false, reviewed: false, partner: null });

    expect((await c.browser.get(`/orders/${c.orderId}/status`)).body.data).toMatchObject({
      status: 'PLACED',
      terminal: false,
    });
    expect((await c.browser.get(`/orders/${c.orderId}/timeline`)).body.data).toHaveLength(1);

    const stranger = await signUpCustomer(ctx);
    for (const path of ['', '/status', '/timeline', '/cancellation-preview'])
      expect((await stranger.browser.get(`/orders/${c.orderId}${path}`)).status).toBe(404);
  });

  it('changes delivery details until pickup (API-ORD-010)', async () => {
    const c = await placeOrder(ctx, { branchId: saffron, items: lines(), paymentMethod: 'COD' });
    const ok = await c.browser.patch(`/orders/${c.orderId}/delivery-details`, {
      deliveryInstructions: 'Ring twice',
      contactPhone: '+919876501234',
    });
    expect(ok.body.data).toMatchObject({
      deliveryInstructions: 'Ring twice',
      contactPhone: '+919876501234',
    });
    expect((await c.browser.patch(`/orders/${c.orderId}/delivery-details`, {})).status).toBe(400);
    await move(c.orderId, ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP']);
    expect(
      (
        await c.browser.patch(`/orders/${c.orderId}/delivery-details`, {
          deliveryInstructions: 'Too late',
        })
      ).body.error.code,
    ).toBe('ORDER_STATE_CONFLICT');
  });
});

suite('reorder (API-ORD-008, BR-ORDER-018)', () => {
  it('rebuilds the cart at current prices and skips what is gone', async () => {
    const regular = (
      await ctx.prisma.foodItemVariant.findFirstOrThrow({
        where: { foodItemId: ids['Chicken Dum Biryani'], name: 'Regular' },
      })
    ).id;
    const c = await placeOrder(ctx, {
      branchId: saffron,
      items: [
        ...lines(),
        {
          foodItemId: ids['Chicken Dum Biryani']!,
          variantId: regular,
          optionIds: [ids.Mild!],
          quantity: 2,
        },
      ],
      paymentMethod: 'COD',
    });
    const paneer = ids['Paneer Biryani']!;
    const chicken = ids['Chicken Dum Biryani']!;
    const before = await ctx.prisma.foodItem.findUniqueOrThrow({ where: { id: paneer } });
    await ctx.prisma.foodItem.update({
      where: { id: paneer },
      data: { basePriceAmount: 29_900, discountedPriceAmount: null },
    });
    await ctx.prisma.branchItemAvailability.upsert({
      where: { branchId_foodItemId: { branchId: saffron, foodItemId: chicken } },
      create: { branchId: saffron, foodItemId: chicken, isAvailable: false },
      update: { isAvailable: false },
    });
    await ctx.prisma.branch.update({
      where: { id: saffron },
      data: { menuVersion: { increment: 1 } },
    });
    try {
      const res = await c.browser.post(`/orders/${c.orderId}/reorder`, {});
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        added: ['Paneer Biryani'],
        skipped: [expect.objectContaining({ itemName: 'Chicken Dum Biryani' })],
      });
      expect(res.body.data.cart.lines).toEqual([
        expect.objectContaining({ foodItemId: paneer, unitAmount: 29_900 + 3_000 }), // new price + raita
      ]);
    } finally {
      await ctx.prisma.foodItem.update({
        where: { id: paneer },
        data: {
          basePriceAmount: before.basePriceAmount,
          discountedPriceAmount: before.discountedPriceAmount,
        },
      });
      await ctx.prisma.branchItemAvailability.deleteMany({
        where: { branchId: saffron, foodItemId: chicken },
      });
      await ctx.prisma.branch.update({
        where: { id: saffron },
        data: { menuVersion: { increment: 1 } },
      });
    }
  });
});

suite('delivery: settlement and invoices (FR-SETTLE-001, FR-CORD-009, BR-ORDER-019)', () => {
  it('settles a delivered order to zero and issues sequential invoices', async () => {
    const orders: string[] = [];
    let c: Awaited<ReturnType<typeof placeOrder>> | undefined;
    for (let i = 0; i < 2; i++) {
      c = await placeOrder(ctx, {
        branchId: saffron,
        items: lines(),
        paymentMethod: 'ONLINE',
        coupon: i === 0 ? 'WELCOME50' : undefined,
      });
      const paid = mock.pay(c.payment.providerOrderId, 'success');
      await c.browser.post(
        `/payments/${c.payment.paymentId}/verify`,
        { providerPaymentId: paid.providerPaymentId, signature: paid.signature },
        key(),
      );
      await ctx.container.outboxRelay.runOnce();
      expect((await c.browser.get(`/orders/${c.orderId}/invoice`)).body.error.code).toBe(
        'ORDER_STATE_CONFLICT',
      );
      await move(c.orderId, TO_DELIVERED);
      const order = await ctx.prisma.order.findUniqueOrThrow({ where: { id: c.orderId } });
      const { split, duplicate } = await ctx.prisma.$transaction((tx) =>
        ctx.container.orderSettlement.settle(tx, order),
      );
      expect(duplicate).toBe(false);
      expect(split.liability).toBe(order.totalAmount);
      expect(
        (await ctx.prisma.$transaction((tx) => ctx.container.orderSettlement.settle(tx, order)))
          .duplicate,
      ).toBe(true);
      expect(
        await ctx.container.ledger.balance(ctx.prisma, {
          ownerType: 'ORDER',
          ownerId: c.orderId,
          type: 'CUSTOMER_ORDER_LIABILITY',
        }),
      ).toBe(0);
      orders.push(c.orderId);
    }
    expect(await ctx.container.ledger.verify()).toEqual([]);

    // The delivery event fixes the invoice number; the PDF reuses it.
    await ctx.container.outboxRelay.runOnce();
    const invoices = await ctx.prisma.invoice.findMany({
      where: { orderId: { in: orders } },
      orderBy: { number: 'asc' },
    });
    expect(invoices).toHaveLength(2);
    expect(invoices[1]!.number).toBe(invoices[0]!.number + 1);
    expect(invoices[0]).toMatchObject({
      series: 'FOS',
      financialYear: financialYear(ctx.clock.now()),
    });

    const pdf = await request(ctx.app)
      .get(`/api/v1/orders/${orders[1]}/invoice`)
      .set('Origin', ORIGINS.CUSTOMER)
      .set('X-Client-App', 'CUSTOMER')
      .set('Authorization', `Bearer ${c!.browser.token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    const body = (pdf.body as Buffer).toString('latin1');
    expect(body.startsWith('%PDF-1.4')).toBe(true);
    expect(body).toContain(`FOS/${invoices[1]!.financialYear}/`);
    expect(body).toContain('Paneer Biryani');
    expect(await ctx.prisma.invoice.count({ where: { orderId: orders[1] } })).toBe(1);
  });

  it('uses the Indian financial year', () => {
    expect(financialYear(new Date('2026-03-31T18:00:00Z'))).toBe('2025-26'); // 31 Mar 23:30 IST
    expect(financialYear(new Date('2026-03-31T18:31:00Z'))).toBe('2026-27'); // 1 Apr 00:01 IST
  });
});
