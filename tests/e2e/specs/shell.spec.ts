import { expect, test } from '@playwright/test';
import { E2E } from '../support/env';

/** Customer app shell: first visit, 404, skip link, and an API that stops answering. */
test.describe('customer app shell', () => {
  test('asks for a location on the first visit', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Let’s find food near you/);
    await page.getByRole('link', { name: 'Choose location' }).click();
    await expect(page.getByRole('heading', { name: 'Where should we deliver?' })).toBeVisible();
  });

  test('shows a 404 page with a way home', async ({ page }) => {
    await page.goto('/definitely-not-a-page');
    await expect(page.getByText('Page not found')).toBeVisible();
    await page.getByRole('link', { name: 'Go to home' }).click();
    await expect(page).toHaveURL(`${E2E.apps.customer}/`);
  });

  test('has a working skip link', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });

  test('explains when restaurants can’t be loaded', async ({ page }) => {
    await page.route('**/api/v1/discovery/**', (route) => route.abort('connectionrefused'));
    await page.goto('/location');
    await page.getByLabel('Latitude').fill('12.929');
    await page.getByLabel('Longitude').fill('77.629');
    await page.getByRole('button', { name: 'Use this location' }).click();
    await expect(page.getByText('Couldn’t load restaurants')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});
