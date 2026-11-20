import { expect, test } from '@playwright/test';
import { codeSentTo, openApp, uniquePhoneDigits } from '../support/fixtures';

/** Phase 4 auth journeys on the customer app (codes read from the worker's message sink). */
test.describe('auth (full stack)', () => {
  test('OTP sign-up for a new number, session survives reload, sign-out ends it', async ({
    browser,
  }) => {
    test.setTimeout(90_000); // includes the 30 s resend cooldown
    const { context, page } = await openApp(browser, 'customer');
    const digits = uniquePhoneDigits();
    await page.goto('/account/security');
    await expect(page).toHaveURL(/\/sign-in\?next=%2Faccount%2Fsecurity$/);

    let since = Date.now() - 1000;
    await page.getByLabel('Mobile number').fill(digits);
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel('6-digit code').fill(await codeSentTo(`+91${digits}`, since));
    await page.getByRole('button', { name: 'Continue' }).click();

    // New number: the used code can't create an account, so collect consent and send a fresh one.
    await expect(page.getByText(/isn't registered yet/)).toBeVisible();
    await page.getByLabel('Full name').fill('Playwright Tester');
    await page.getByLabel(/I accept the terms/).check();
    const sendNew = page.getByRole('button', { name: /Send new code/ });
    await expect(sendNew).toBeDisabled(); // resend cooldown
    await expect(sendNew).toBeEnabled({ timeout: 35_000 });
    since = Date.now() - 1000;
    await sendNew.click();
    await page.getByLabel('6-digit code').fill(await codeSentTo(`+91${digits}`, since));
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page).toHaveURL(/\/account\/security$/);
    await expect(page.getByText('This device')).toBeVisible();

    // The access token lives in memory only; the refresh cookie is HttpOnly.
    expect(await page.evaluate(() => [localStorage.length, document.cookie])).toEqual([0, '']);
    await page.reload();
    await expect(page.getByText('This device')).toBeVisible();

    await page.getByRole('button', { name: 'Playwright Tester' }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto('/account/security');
    await expect(page).toHaveURL(/\/sign-in\?next=/);
    await context.close();
  });

  test('a wrong code is rejected with a clear message', async ({ browser }) => {
    const { context, page } = await openApp(browser, 'customer');
    await page.goto('/sign-in');
    await page.getByLabel('Mobile number').fill(uniquePhoneDigits());
    await page.getByRole('button', { name: 'Send code' }).click();
    await page.getByLabel('6-digit code').fill('000000');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText(/code/i);
    await context.close();
  });
});
