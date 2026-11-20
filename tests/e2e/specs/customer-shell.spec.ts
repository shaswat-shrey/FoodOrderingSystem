import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('customer app shell', () => {
  test('renders, marks unbuilt features and handles an unreachable API', async ({ page }) => {
    // The API is not running in this smoke suite, so the status card must degrade gracefully.
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'FoodOrderSystem' })).toBeVisible();
    await expect(page.getByText(/Awaiting implementation/)).toBeVisible();
    await expect(page.getByRole('img', { name: 'Vegetarian', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 15_000 });
  });

  test('shows a 404 page with a way home', async ({ page }) => {
    await page.goto('/definitely-not-a-page');
    await expect(page.getByText('Page not found')).toBeVisible();
    await page.getByRole('link', { name: 'Go to home' }).click();
    await expect(page).toHaveURL('/');
  });

  test('has a working skip link', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });

  test('AC-NFR-002 has no serious or critical accessibility violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 15_000 });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(
      blocking,
      JSON.stringify(
        blocking.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
        null,
        2,
      ),
    ).toEqual([]);
  });
});
