import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Full-stack auth journeys (Phase 4). Opt-in: needs the API, the worker
 * (DEV_MESSAGE_SINK=file) and the database running locally, so codes can be
 * read from the dev message log exactly as a user would read their SMS.
 *
 *   E2E_FULL_STACK=1 pnpm --filter @fos/e2e e2e fullstack
 *
 * One run requests 6 codes from localhost; the per-IP limit is 10 an hour
 * (BR-AUTH-003). To rerun sooner against the local dev Redis:
 *   redis-cli -p 6390 del 'rl:auth:otp:ip:::1'
 */
test.skip(!process.env.E2E_FULL_STACK, 'set E2E_FULL_STACK=1 with the API and worker running');

const MESSAGE_LOG = fileURLToPath(new URL('../../../.local/dev-messages.log', import.meta.url));

function uniquePhoneDigits(): string {
  return `9${String(Date.now()).slice(-6)}${Math.floor(100 + Math.random() * 900)}`;
}

/** Waits for a message to `to` sent after `since` and returns the 6-digit code. */
async function codeSentTo(to: string, since: number): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const raw = await readFile(MESSAGE_LOG, 'utf8').catch(() => '');
    const match = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { at: string; to: string; text: string })
      .reverse()
      .find((m) => m.to === to && Date.parse(m.at) >= since);
    const code = match?.text.match(/\b(\d{6})\b/)?.[1];
    if (code) return code;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no code sent to ${to}`);
}

async function requestCode(page: Page, digits: string) {
  const since = Date.now() - 1000;
  await page.getByLabel('Mobile number').fill(digits);
  await page.getByRole('button', { name: 'Send code' }).click();
  return codeSentTo(`+91${digits}`, since);
}

test.describe('auth (full stack)', () => {
  test('OTP sign-up for a new number, session survives reload, sign-out ends it', async ({
    page,
  }) => {
    test.setTimeout(90_000); // includes the 30 s resend cooldown
    const digits = uniquePhoneDigits();
    await page.goto('/account/security');
    await expect(page).toHaveURL(/\/sign-in\?next=%2Faccount%2Fsecurity$/);

    const first = await requestCode(page, digits);
    await page.getByLabel('6-digit code').fill(first);
    await page.getByRole('button', { name: 'Continue' }).click();

    // New number: the used code can't create an account, so collect consent and send a fresh one.
    await expect(page.getByText(/isn't registered yet/)).toBeVisible();
    await page.getByLabel('Full name').fill('Playwright Tester');
    await page.getByLabel(/I accept the terms/).check();
    const sendNew = page.getByRole('button', { name: /Send new code/ });
    await expect(sendNew).toBeDisabled(); // resend cooldown
    await expect(sendNew).toBeEnabled({ timeout: 35_000 });
    const since = Date.now() - 1000;
    await sendNew.click();
    const second = await codeSentTo(`+91${digits}`, since);
    await page.getByLabel('6-digit code').fill(second);
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page).toHaveURL(/\/account\/security$/);
    await expect(page.getByText('This device')).toBeVisible();

    // The access token lives in memory only; the refresh cookie is HttpOnly.
    expect(
      await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]),
    ).toEqual([0, 0, '']);
    await page.reload();
    await expect(page.getByText('This device')).toBeVisible();

    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto('/account/security');
    await expect(page).toHaveURL(/\/sign-in\?next=/);
  });

  test('a wrong code is rejected with a clear message', async ({ page }) => {
    await page.goto('/sign-in');
    await requestCode(page, uniquePhoneDigits());
    await page.getByLabel('6-digit code').fill('000000');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toContainText(/code/i);
  });

  test('AC-NFR-002 sign-in and sign-up have no serious accessibility violations', async ({
    page,
  }) => {
    for (const path of ['/sign-in', '/sign-up']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
        .analyze();
      const blocking = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(
        blocking.map((v) => v.id),
        path,
      ).toEqual([]);
    }
  });
});
