import { expect, test } from '@playwright/test';
import { PLACES, SEED } from '../support/env';
import {
  addDish,
  checkout,
  expectAccessible,
  goOffline,
  goOnline,
  moveTo,
  newCustomer,
  offerCard,
  openApp,
  openRestaurant,
  orderCard,
  orderNumber,
  pay,
  queueTab,
  setLocation,
  signInWithOtp,
  signInStaff,
  signUpCustomer,
} from '../support/fixtures';

/**
 * AC-E2E-001 (customer), AC-E2E-002 (restaurant) and AC-E2E-003 (partner) are one
 * order seen from three browsers at once, so they run as one journey. Every
 * cross-app change is waited for on screen — pushed over the socket, with the
 * apps' own polling as the fallback — never by reloading.
 */
test('AC-E2E-001/002/003 one order from sign-up to delivery across the three apps', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const near = { latitude: 12.936, longitude: 77.6241 }; // ~110 m from the branch
  const customer = await openApp(browser, 'customer');
  const restaurant = await openApp(browser, 'restaurant');
  const partner = await openApp(browser, 'delivery', { geolocation: near });
  const c = newCustomer('Journey Customer');

  await test.step('restaurant manager signs in and watches the order queue', async () => {
    const { page } = restaurant;
    await signInStaff(page, SEED.manager.phone);
    await page.goto('/orders');
    await page.getByLabel('Outlet').selectOption({ label: 'Koramangala' });
    await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible();
    await expectAccessible(page, 'restaurant orders');
  });

  await test.step('AC-E2E-001 customer registers with a phone code and sets a location', async () => {
    const { page } = customer;
    await signUpCustomer(page, c);
    await setLocation(page, PLACES.koramangalaHome, 'Koramangala');
    await expect(page.getByRole('heading', { name: /\d+\+? restaurants/ })).toBeVisible();
    await expectAccessible(page, 'customer home');
  });

  await test.step('customer opens the restaurant and customises a dish', async () => {
    const { page } = customer;
    await openRestaurant(page, SEED.restaurant, 'Koramangala');
    await expectAccessible(page, 'restaurant page');
    await addDish(page, 'Chicken Dum Biryani', async (dialog) => {
      await dialog.getByRole('radio', { name: 'Family pack (serves 3)' }).check();
      await dialog.getByRole('radio', { name: 'Hot' }).check();
      await dialog.getByRole('checkbox', { name: /Extra raita/ }).check();
    });
  });

  await test.step('cart with a coupon, then checkout and the dev payment', async () => {
    const { page } = customer;
    await page.getByRole('link', { name: /View cart/ }).click();
    await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible();
    await expect(page.getByText('Family pack (serves 3), Hot, Extra raita')).toBeVisible();
    await page.getByLabel('Coupon code').fill('WELCOME50');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText(/WELCOME50 applied: you save ₹100/)).toBeVisible();
    await expectAccessible(page, 'cart');
    await page.getByRole('button', { name: 'Proceed to checkout' }).click();
    await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible();
    await expectAccessible(page, 'checkout');
    await checkout(page, {
      address: { ...PLACES.koramangalaHome, area: 'Koramangala' },
      tip: '₹20',
    });
    await pay(page, 'Payment succeeds');
    await expect(page.getByText('Order placed!')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Order placed — waiting for the restaurant',
    );
    await expectAccessible(page, 'order tracking');
  });
  const number = await orderNumber(customer.page);

  await test.step('AC-E2E-002 the new order appears in the restaurant queue live', async () => {
    const card = orderCard(restaurant.page, number);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Chicken Dum Biryani (Family pack (serves 3))');
    await expect(card).toContainText('Paid');
  });

  await test.step('AC-E2E-003 partner signs in and goes online near the restaurant', async () => {
    await signInWithOtp(partner.page, SEED.partners.journey);
    await goOnline(partner.page);
    await expectAccessible(partner.page, 'partner shift');
  });

  await test.step('restaurant accepts with a short prep time; customer sees it live', async () => {
    const card = orderCard(restaurant.page, number);
    // 15 min or less: dispatch starts at acceptance (DELIVERY-ASSIGNMENT-ALGORITHM).
    await card.getByLabel('Prep time (minutes)').fill('15');
    await card.getByRole('button', { name: 'Accept' }).click();
    await expect(customer.page.getByRole('heading', { level: 1 })).toHaveText(
      'Restaurant accepted your order',
    );
  });

  let pickupCode = '';
  await test.step('partner receives the offer live and accepts it', async () => {
    const offer = offerCard(partner.page);
    await expect(offer).toBeVisible({ timeout: 45_000 });
    await expect(offer).toContainText(`${SEED.restaurant}, Koramangala`);
    await expect(offer).toContainText('Prepaid');
    await offer.getByRole('button', { name: 'Accept' }).click();
    await expect(partner.page).toHaveURL(/\/delivery$/);
    await expect(
      partner.page.getByRole('heading', { name: 'Head to the restaurant' }),
    ).toBeVisible();
    pickupCode = (await partner.page.getByLabel('Pickup code').textContent())?.trim() ?? '';
    expect(pickupCode).toMatch(/^\d{4}$/);
    await expectAccessible(partner.page, 'partner trip');
    // The customer sees who is coming (delivery.partner_assigned).
    await expect(
      customer.page.getByRole('heading', { name: 'Your delivery partner' }),
    ).toBeVisible();
  });

  await test.step('restaurant starts preparing; partner arrives; food is ready', async () => {
    const { page } = restaurant;
    // Accepted orders wait in the Preparing tab until the kitchen starts.
    await queueTab(page, 'Preparing');
    await orderCard(page, number).getByRole('button', { name: 'Start preparing' }).click();
    await expect(customer.page.getByRole('heading', { level: 1 })).toHaveText(
      'Preparing your food',
    );
    await partner.page.getByRole('button', { name: 'Arrived at the restaurant' }).click();
    await expect(partner.page.getByRole('heading', { name: 'At the restaurant' })).toBeVisible();
    await expect(
      customer.page.getByText('Your delivery partner is at the restaurant'),
    ).toBeVisible();

    await orderCard(page, number).getByRole('button', { name: 'Mark ready' }).click();
    await expect(customer.page.getByRole('heading', { level: 1 })).toHaveText('Ready for pickup');
  });

  await test.step('AC-E2E-002 handover against the partner’s pickup code', async () => {
    const { page } = restaurant;
    await queueTab(page, 'Ready');
    await orderCard(page, number).getByRole('button', { name: 'Details and handover' }).click();
    const drawer = page.getByRole('dialog', { name: `Order ${number}` });
    await expect(drawer.getByText(/has arrived/)).toBeVisible();
    await drawer.getByLabel('Partner’s pickup code').fill(pickupCode);
    await drawer.getByRole('button', { name: 'Hand over order' }).click();
    await expect(drawer.getByText(/has picked up the order/)).toBeVisible();
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(customer.page.getByRole('heading', { level: 1 })).toHaveText('On the way');
  });

  await test.step('AC-E2E-003 partner rides to the customer and completes with the code', async () => {
    const { page } = partner;
    // The handover was done by the restaurant: the trip screen moves on by itself.
    await expect(page.getByRole('heading', { name: 'On the way to the customer' })).toBeVisible({
      timeout: 20_000,
    });
    await moveTo(partner, PLACES.koramangalaHome);
    await page.getByRole('button', { name: 'Arrived at the customer' }).click();
    await expect(page.getByRole('heading', { name: 'At the customer' })).toBeVisible();
    await expect(customer.page.getByText('Your delivery partner has arrived')).toBeVisible();

    const codeText = await customer.page.getByText(/Share this code at delivery/).textContent();
    const code = codeText?.match(/(\d{4})/)?.[1];
    expect(code, 'delivery code on the tracking page').toBeTruthy();
    await page.getByLabel('Delivery code from the customer').fill(code!);
    await page.getByRole('button', { name: 'Complete delivery' }).click();
    await expect(page.getByRole('heading', { name: 'Delivered', level: 1 })).toBeVisible();
    await expect(
      page.getByText(/Nice work\. You earned ₹[\d,.]+, including a ₹20 tip\./),
    ).toBeVisible();
    await expect(customer.page.getByRole('heading', { level: 1 })).toHaveText(
      'Delivered — enjoy your meal!',
    );
  });

  await test.step('partner earnings are updated', async () => {
    const { page } = partner;
    await page.getByRole('link', { name: 'Back to your shift' }).click();
    const today = page.locator('section', { has: page.getByRole('heading', { name: 'Today' }) });
    await expect(today).toContainText(/Deliveries\s*1(?!\d)/);
    await expect(today).toContainText(/Tips\s*₹20(?![\d.])/);
    await goOffline(page);
  });

  await test.step('AC-E2E-002 the order is completed in history and on the dashboard', async () => {
    const { page } = restaurant;
    await queueTab(page, 'Completed');
    await expect(orderCard(page, number)).toBeVisible();
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.getByRole('heading', { name: /^Today at / })).toBeVisible();
    await expect(page.getByRole('main')).toContainText(/Delivered\s*1(?!\d)/);
  });

  await Promise.all([customer, restaurant, partner].map((a) => a.context.close()));
});
