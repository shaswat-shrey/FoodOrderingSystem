import { expect, request, test } from '@playwright/test';
import { E2E } from '../support/env';
import { createCustomer, openApp } from '../support/fixtures';

const COOKIE = 'fos_rt_customer';

/**
 * AC-E2E-009 (FR-AUTH-022): a refresh token copied from the browser and replayed
 * after the legitimate tab has rotated it revokes the whole session, and every
 * open tab of that session is signed out.
 */
test('AC-E2E-009 a replayed refresh token revokes the session in every tab', async ({
  browser,
}) => {
  const customer = await openApp(browser, 'customer');
  await createCustomer(customer);
  const tabA = customer.page;
  await tabA.goto('/account/security');
  await expect(tabA.getByText('This device')).toBeVisible();
  const tabB = await customer.context.newPage();
  await tabB.goto('/orders');
  await expect(tabB.getByRole('heading', { name: 'Your orders', level: 1 })).toBeVisible();

  // The attacker copies the current refresh token…
  const stolen = (await customer.context.cookies()).find((c) => c.name === COOKIE)?.value;
  expect(stolen).toBeTruthy();

  // …the legitimate tab rotates it (a reload restores the session from the cookie)…
  await tabA.reload();
  await expect(tabA.getByText('This device')).toBeVisible();
  const current = (await customer.context.cookies()).find((c) => c.name === COOKIE)?.value;
  expect(current).not.toBe(stolen);

  // …and once the 10 s race grace (BR-AUTH-007) is over the stolen copy is replayed.
  await tabA.waitForTimeout(11_000);
  const attacker = await request.newContext({
    baseURL: E2E.apps.customer,
    extraHTTPHeaders: {
      'X-Client-App': 'CUSTOMER',
      Origin: E2E.apps.customer,
      Cookie: `${COOKIE}=${stolen}`,
      'X-Forwarded-For': '203.0.113.9',
    },
  });
  const replay = await attacker.post('/api/v1/auth/refresh');
  expect(replay.status()).toBe(401);
  expect(((await replay.json()) as { error: { code: string } }).error.code).toBe(
    'AUTH_REFRESH_REUSED',
  );
  await attacker.dispose();

  // Both tabs lose the session: B on its next request, A on its next refresh.
  const active = tabB.getByRole('tab', { name: 'Active' });
  await active.or(tabB.getByRole('button', { name: 'Active', exact: true })).click();
  await expect(tabB).toHaveURL(/\/sign-in/);
  await tabA.reload();
  await expect(tabA).toHaveURL(/\/sign-in/);
  await customer.context.close();
});
