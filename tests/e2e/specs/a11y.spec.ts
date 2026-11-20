import { expect, test } from '@playwright/test';
import { PLACES, SEED } from '../support/env';
import {
  addDish,
  createCustomer,
  expectAccessible,
  gotoSignedIn,
  KORAMANGALA,
  openApp,
  openRestaurant,
  placePaidOrder,
  setLocation,
  signInAdmin,
  signInStaff,
  signInWithOtp,
} from '../support/fixtures';

/**
 * AC-NFR-002 (NFR-ACCESS-007): zero serious/critical axe violations on the key
 * pages of each app, on desktop and on a phone. The journey also checks the
 * live screens (tracking, trip) mid-delivery.
 */
const mobile = () => test.info().project.name.startsWith('mobile');

test.describe('AC-NFR-002 accessibility', () => {
  test('customer: sign-in, home, restaurant, cart, checkout and tracking', async ({ browser }) => {
    const customer = await openApp(browser, 'customer');
    const { page } = customer;
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expectAccessible(page, 'customer sign-in');
    await page.goto('/sign-up');
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    await expectAccessible(page, 'customer sign-up');

    await createCustomer(customer);
    await setLocation(page, PLACES.koramangalaHome, 'Koramangala');
    await expect(page.getByRole('heading', { name: /\d+\+? restaurants/ })).toBeVisible();
    await expectAccessible(page, 'customer home');

    await openRestaurant(page, SEED.restaurant, 'Koramangala');
    await expect(page.getByRole('heading', { name: 'Biryani', level: 2 })).toBeVisible();
    await expectAccessible(page, 'restaurant page');
    await page.getByRole('button', { name: 'Add Chicken Dum Biryani' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectAccessible(page, 'dish options sheet');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await addDish(page, 'Mutton Biryani');

    await gotoSignedIn(page, '/cart');
    await expect(page.getByRole('heading', { name: 'Bill details' })).toBeVisible();
    await expectAccessible(page, 'cart');
    await gotoSignedIn(page, '/checkout');
    await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Add address' }).click();
    await expectAccessible(page, 'checkout with the address form');

    const order = await placePaidOrder(page, KORAMANGALA);
    await expect(page.getByRole('heading', { name: 'Status' })).toBeVisible();
    await expectAccessible(page, 'order tracking');

    // Leave nothing for the restaurant: cancel while it is still free.
    await page.getByRole('button', { name: 'Cancel order' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel this order?' });
    await expect(dialog.getByText('Free', { exact: true })).toBeVisible();
    await expectAccessible(page, 'cancellation dialog');
    await dialog.getByRole('button', { name: 'Cancel order' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Cancelled');
    expect(order.number).toBeTruthy();
    await customer.context.close();
  });

  test('restaurant: sign-in, orders and menu', async ({ browser }) => {
    const { context, page } = await openApp(browser, 'restaurant');
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expectAccessible(page, 'restaurant sign-in');
    await signInStaff(page, SEED.owner.phone);
    await page.goto('/orders');
    await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^New/ })).toBeVisible();
    await expectAccessible(page, 'restaurant orders');
    await page.goto('/menu');
    await expect(page.getByRole('heading', { name: 'Menu', level: 1 })).toBeVisible();
    await expect(page.getByText('Chicken Dum Biryani').first()).toBeVisible();
    await expectAccessible(page, 'restaurant menu');
    await context.close();
  });

  test('partner: sign-in, shift and trip', async ({ browser }) => {
    const { context, page } = await openApp(browser, 'delivery', {
      geolocation: { latitude: 12.97, longitude: 77.642 },
    });
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expectAccessible(page, 'partner sign-in');
    // A different partner per project: each number has a 30 s resend cooldown.
    await signInWithOtp(page, mobile() ? '9000000405' : SEED.partners.a11y);
    await expect(page.getByRole('heading', { name: 'Your shift' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go online' })).toBeVisible();
    await expectAccessible(page, 'partner shift');
    await page.goto('/delivery');
    await expect(page.getByRole('heading', { name: 'No delivery in progress' })).toBeVisible();
    await expectAccessible(page, 'partner trip (none active)');
    await page.goto('/earnings');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(page, 'partner earnings');
    await context.close();
  });

  test('admin: sign-in, dashboard and orders', async ({ browser }) => {
    const { context, page } = await openApp(browser, 'admin');
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expectAccessible(page, 'admin sign-in');
    await signInAdmin(page, mobile() ? SEED.opsAdmin.email : SEED.admin.email);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByText('Active orders')).toBeVisible();
    await expectAccessible(page, 'admin dashboard');
    await page.goto('/orders');
    await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible();
    await expectAccessible(page, 'admin orders');
    await page.goto('/dispatch');
    await expect(page.getByRole('heading', { name: 'Dispatch board', level: 1 })).toBeVisible();
    await expectAccessible(page, 'admin dispatch board');
    await context.close();
  });
});
