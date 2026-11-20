import { expect, test, type Page } from '@playwright/test';
import { expireNoPartnerDeadline } from '../support/db';
import { SEED } from '../support/env';
import {
  acceptOrder,
  addDish,
  checkout,
  createCustomer,
  customerWithOrder,
  goOffline,
  goOnline,
  gotoSignedIn,
  INDIRANAGAR,
  KORAMANGALA,
  offerCard,
  openApp,
  openRestaurant,
  orderCard,
  orderDetails,
  orderNumber,
  pay,
  restaurantQueue,
  setLocation,
  signInAdmin,
  signInWithOtp,
  type Actor,
} from '../support/fixtures';

const heading = (page: Page) => page.getByRole('heading', { level: 1 });

/** Free cancellation while the order still waits for the restaurant (keeps the queue clean). */
async function cancelWhilePlaced(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Cancel order' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel this order?' });
  await expect(dialog.getByText('Free')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel order' }).click();
  await expect(heading(page)).toHaveText('Cancelled');
}

test.describe('failure journeys', () => {
  test('AC-E2E-004 a failed payment can be retried and the order is placed once', async ({
    browser,
  }) => {
    const customer = await openApp(browser, 'customer');
    const { page } = customer;
    await createCustomer(customer);
    await setLocation(page, KORAMANGALA.place, KORAMANGALA.area);
    await openRestaurant(page, SEED.restaurant, 'Koramangala');
    await addDish(page, 'Mutton Biryani');
    await checkout(page, { address: { ...KORAMANGALA.place, area: KORAMANGALA.area } });

    await pay(page, 'Payment fails');
    await expect(page.getByText('Payment failed')).toBeVisible();
    await expect(heading(page)).toHaveText('Complete payment');

    await pay(page, 'Payment succeeds');
    await expect(page.getByText('Order placed!')).toBeVisible({ timeout: 30_000 });
    await expect(heading(page)).toHaveText('Order placed — waiting for the restaurant');
    const number = await orderNumber(page);
    const id = page.url().match(/\/orders\/([^/?#]+)/)![1]!;

    // One order, paid once: the failed attempt and one captured payment.
    await gotoSignedIn(page, '/orders');
    const orders = page.getByRole('list', { name: 'Orders' }).locator(':scope > li');
    await expect(orders).toHaveCount(1);
    await expect(orders).toContainText(number);
    const details = await orderDetails(page, id);
    expect(details.status).toBe('PLACED');
    expect(details.payments.filter((p) => p.status === 'CAPTURED')).toHaveLength(1);

    await cancelWhilePlaced(page);
    await customer.context.close();
  });

  test('AC-E2E-005 the restaurant rejects: the customer is told and refunded', async ({
    browser,
  }) => {
    const restaurant = await restaurantQueue(browser, 'Koramangala');
    const customer = await customerWithOrder(browser, KORAMANGALA);
    const { number, id } = customer.order;

    const card = orderCard(restaurant.page, number);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Reject' }).click();
    await card.getByLabel('Reason').selectOption({ label: 'Kitchen too busy' });
    await card.getByRole('button', { name: 'Confirm reject' }).click();
    await expect(card).toBeHidden();

    // Live on the tracking page, then the refund behind it.
    await expect(heading(customer.page)).toHaveText('Restaurant couldn’t accept');
    await expect(
      customer.page.getByText('The restaurant couldn’t accept this order'),
    ).toBeVisible();
    const details = await orderDetails(customer.page, id);
    await expect(customer.page.getByText(/₹[\d,.]+ will be refunded\./)).toBeVisible();
    expect(details.status).toBe('REJECTED');
    expect(details.refunds).toHaveLength(1);
    expect(details.refunds[0]!.amount).toBe(details.breakdown.payable);

    await Promise.all([restaurant, customer].map((a) => a.context.close()));
  });

  test('AC-E2E-006 a partner declines the offer and the next partner gets it', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const near = { latitude: 12.936, longitude: 77.6241 };
    const restaurant = await restaurantQueue(browser, 'Koramangala');
    const first = await openApp(browser, 'delivery', { geolocation: near });
    const second = await openApp(browser, 'delivery', {
      geolocation: { latitude: 12.9345, longitude: 77.6236 },
    });
    const customer = await customerWithOrder(browser, KORAMANGALA);

    await signInWithOtp(first.page, SEED.partners.rejecter);
    await signInWithOtp(second.page, SEED.partners.acceptor);
    await goOnline(first.page);
    await goOnline(second.page);
    await acceptOrder(restaurant.page, customer.order.number);

    // Whoever is offered first declines (BR-DEL-004: never offered this delivery again).
    const offered = await firstOffered([first, second]);
    const other = offered === first ? second : first;
    await offerCard(offered.page).getByRole('button', { name: 'Decline' }).click();
    await expect(offerCard(offered.page)).toBeHidden();

    const offer = offerCard(other.page);
    await expect(offer).toBeVisible({ timeout: 45_000 });
    await offer.getByRole('button', { name: 'Accept' }).click();
    await expect(other.page).toHaveURL(/\/delivery$/);
    await expect(other.page.getByRole('heading', { name: 'Head to the restaurant' })).toBeVisible();
    await expect(offerCard(offered.page)).toBeHidden();

    // The customer and the restaurant see the assignment.
    await expect(
      customer.page.getByRole('heading', { name: 'Your delivery partner' }),
    ).toBeVisible();
    const name = other === first ? 'Ravi' : 'Pooja';
    await expect(customer.page.getByText(name, { exact: true })).toBeVisible();

    // Clean up: the customer cancels (the partner is released) and both go offline.
    await customer.page.getByRole('button', { name: 'Cancel order' }).click();
    const dialog = customer.page.getByRole('dialog', { name: 'Cancel this order?' });
    await dialog.getByRole('button', { name: 'Cancel order' }).click();
    await expect(heading(customer.page)).toHaveText('Cancelled');
    await expect(other.page.getByRole('heading', { name: 'Head to the restaurant' })).toBeHidden({
      timeout: 30_000,
    });
    await goOffline(first.page);
    await goOffline(second.page);
    await Promise.all([restaurant, first, second, customer].map((a) => a.context.close()));
  });

  test('AC-E2E-007 cancelling after the free window shows the fee and refunds the rest', async ({
    browser,
  }) => {
    const restaurant = await restaurantQueue(browser, 'Koramangala');
    const customer = await customerWithOrder(browser, KORAMANGALA);
    const { page } = customer;
    await acceptOrder(restaurant.page, customer.order.number);
    await expect(heading(page)).toHaveText('Restaurant accepted your order');

    // Inside the free window (15 s in the E2E data; 60 s by default).
    await page.getByRole('button', { name: 'Cancel order' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel this order?' });
    await expect(dialog.getByText(/Free to cancel until/)).toBeVisible();
    await expect(dialog.getByText('Free', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep order' }).click();

    await page.waitForTimeout(16_000);
    await page.getByRole('button', { name: 'Cancel order' }).click();
    await expect(dialog).toBeVisible();
    const amount = async (label: string) =>
      (await dialog.getByText(label, { exact: true }).locator('..').textContent())!
        .replace(label, '')
        .trim();
    const fee = await amount('Cancellation fee');
    const refund = await amount('Refund');
    expect(fee).toMatch(/^₹[\d,.]+$/);
    expect(refund).toMatch(/^₹[\d,.]+$/);
    await dialog.getByLabel('Reason').selectOption({ label: 'I changed my mind' });
    await dialog.getByRole('button', { name: 'Cancel order' }).click();
    await expect(heading(page)).toHaveText('Cancelled');
    await expect(page.getByText(`${refund} will be refunded.`)).toBeVisible();

    const details = await orderDetails(page, customer.order.id);
    const paise = (r: string) => Math.round(Number(r.replace(/[₹,]/g, '')) * 100);
    expect(details.cancellation?.feeAmount).toBe(paise(fee));
    expect(details.cancellation?.refundAmount).toBe(paise(refund));
    expect(details.cancellation!.feeAmount + details.cancellation!.refundAmount).toBe(
      details.breakdown.payable,
    );
    expect(details.refunds.map((r) => r.amount)).toEqual([paise(refund)]);
    await Promise.all([restaurant, customer].map((a) => a.context.close()));
  });

  test('AC-E2E-008 no partner: escalation, then cancellation and refund at the deadline', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    // Indiranagar (blr-east): no partner there is online during the suite.
    const restaurant = await restaurantQueue(browser, 'Indiranagar');
    const customer = await customerWithOrder(browser, INDIRANAGAR);
    const { number, id } = customer.order;
    await acceptOrder(restaurant.page, number);
    await expect(heading(customer.page)).toHaveText('Restaurant accepted your order');

    const admin = await openApp(browser, 'admin');
    await signInAdmin(admin.page, SEED.admin.email);
    await admin.page.goto('/dispatch');
    await admin.page.getByLabel('Escalation').selectOption({ label: 'Escalated only' });
    const row = admin.page.getByRole('row').filter({ hasText: number });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(/escalated/i);

    // BR-DEL-003's deadline (≥ 30 min) is brought forward; the worker's own
    // once-a-minute dispatch retry/sweep then cancels the order for want of a partner.
    expireNoPartnerDeadline(id);
    await expect(heading(customer.page)).toHaveText('Cancelled', { timeout: 100_000 });
    const details = await orderDetails(customer.page, id);
    await expect(customer.page.getByText(/₹[\d,.]+ will be refunded\./)).toBeVisible();
    expect(details.cancellation?.reasonCode).toBe('NO_PARTNER');
    expect(details.cancellation?.feeAmount).toBe(0);
    expect(details.refunds.map((r) => r.amount)).toEqual([details.breakdown.payable]);

    await admin.page.goto(`/orders/${id}`);
    await expect(admin.page.getByRole('heading', { name: `Order ${number}` })).toBeVisible();
    await expect(admin.page.getByText('Cancelled').first()).toBeVisible();
    await Promise.all([restaurant, customer, admin].map((a) => a.context.close()));
  });
});

/** Resolves with the partner whose offer card shows first. */
async function firstOffered(partners: Actor[]): Promise<Actor> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    for (const p of partners) if (await offerCard(p.page).isVisible()) return p;
    await partners[0]!.page.waitForTimeout(250);
  }
  throw new Error('no partner was offered the delivery');
}
