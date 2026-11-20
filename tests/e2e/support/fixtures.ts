import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { E2E, PLACES } from './env';

export type AppName = keyof typeof E2E.apps;
const CLIENT_APP: Record<AppName, string> = {
  customer: 'CUSTOMER',
  restaurant: 'RESTAURANT',
  delivery: 'DELIVERY',
  admin: 'ADMIN',
};

/** Per-run values written by global setup. */
export function runValues(): { staffPassword: string } {
  return JSON.parse(readFileSync(E2E.runFile, 'utf8')) as { staffPassword: string };
}

let ipCounter = 0;
/**
 * Each browser is a different "device": the API trusts one proxy hop, so a
 * distinct X-Forwarded-For per context gives each its own client IP for the
 * per-IP auth limits (BR-AUTH-003/004), as real users would have.
 */
function uniqueIp(): string {
  ipCounter += 1;
  const n = (process.pid % 200) * 1000 + ipCounter;
  return `10.${Math.floor(n / 65_536) % 256}.${Math.floor(n / 256) % 256}.${n % 256}`;
}

export interface Actor {
  context: BrowserContext;
  page: Page;
  app: AppName;
}

/** A fresh browser context for one app (its own cookies, IP and, for partners, location). */
export async function openApp(
  browser: Browser,
  app: AppName,
  options: { geolocation?: { latitude: number; longitude: number } } = {},
): Promise<Actor> {
  const context = await browser.newContext({
    baseURL: E2E.apps[app],
    extraHTTPHeaders: { 'X-Forwarded-For': uniqueIp() },
    ...(options.geolocation
      ? { geolocation: { ...options.geolocation, accuracy: 10 }, permissions: ['geolocation'] }
      : {}),
  });
  const page = await context.newPage();
  return { context, page, app };
}

/* ------------------------------ messages ------------------------------ */

interface SinkMessage {
  at: string;
  channel: string;
  to: string;
  subject?: string;
  text: string;
}

/** Waits for a message to `to` written by the worker after `since`; returns its 6-digit code. */
export async function codeSentTo(to: string, since: number, pattern = /\b(\d{6})\b/) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const raw = await readFile(E2E.messageLog, 'utf8').catch(() => '');
    const match = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SinkMessage)
      .reverse()
      .find((m) => m.to === to && Date.parse(m.at) >= since && pattern.test(m.text));
    const code = match?.text.match(pattern)?.[1];
    if (code) return code;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no code sent to ${to}`);
}

/* ------------------------------ sign-in ------------------------------ */

let phoneCounter = 0;
/** A 10-digit Indian mobile number unlikely to repeat across runs. */
export function uniquePhoneDigits(): string {
  phoneCounter += 1;
  const tail = `${Date.now() % 1_000_000}`.padStart(6, '0');
  return `8${tail}${String(phoneCounter % 1000).padStart(3, '0')}`;
}

export interface Customer {
  name: string;
  phone: string;
  email: string;
  password: string;
}

export function newCustomer(name = 'Playwright Customer'): Customer {
  const digits = uniquePhoneDigits();
  return {
    name,
    phone: digits,
    email: `e2e.${digits}@example.com`,
    password: `tandoori ${digits} breeze`,
  };
}

/** FR-AUTH-001 through the UI: sign-up, then the phone code from the message sink. */
export async function signUpCustomer(page: Page, c: Customer): Promise<void> {
  await page.goto('/sign-up');
  await page.getByLabel('Full name').fill(c.name);
  await page.getByLabel('Email').fill(c.email);
  await page.getByLabel('Mobile number').fill(c.phone);
  await page.getByLabel('Password', { exact: true }).fill(c.password);
  await page.getByLabel(/I accept the terms/).check();
  const since = Date.now() - 1000;
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Verify your mobile number' })).toBeVisible();
  const code = await codeSentTo(`+91${c.phone}`, since);
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).not.toHaveURL(/verify-phone/);
}

/**
 * A signed-in customer without going through the sign-up screens (the journey
 * covers those): register and verify through the API from the page's own
 * context, so the refresh cookie lands in the browser.
 */
export async function createCustomer(actor: Actor, c = newCustomer()): Promise<Customer> {
  const headers = { 'X-Client-App': 'CUSTOMER', Origin: E2E.apps.customer };
  const since = Date.now() - 1000;
  const reg = await actor.context.request.post('/api/v1/auth/register', {
    headers,
    data: {
      fullName: c.name,
      email: c.email,
      phone: `+91${c.phone}`,
      password: c.password,
      acceptTerms: true,
    },
  });
  expect(reg.status(), await reg.text()).toBe(201);
  const token = ((await reg.json()) as { data: { accessToken: string } }).data.accessToken;
  const code = await codeSentTo(`+91${c.phone}`, since);
  const verify = await actor.context.request.post('/api/v1/auth/phone/verify', {
    headers: { ...headers, Authorization: `Bearer ${token}` },
    data: { code },
  });
  expect(verify.ok(), await verify.text()).toBe(true);
  return c;
}

/** Restaurant staff and admins sign in with the password set in global setup. */
export async function signInWithPassword(page: Page, identifier: string): Promise<void> {
  await page.goto('/sign-in');
  const tab = page.getByRole('tab', { name: 'Password' });
  if (await tab.isVisible()) await tab.click();
  await page.getByLabel('Email or mobile number').fill(identifier);
  await page.getByLabel('Password', { exact: true }).fill(runValues().staffPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Restaurant staff: password sign-in, then the app's home. */
export async function signInStaff(page: Page, identifier: string): Promise<void> {
  await signInWithPassword(page, identifier);
  await expect(page).not.toHaveURL(/sign-in/);
}

/** BR-AUTH-018: admin password, then the emailed second factor. */
export async function signInAdmin(page: Page, email: string): Promise<void> {
  const since = Date.now() - 1000;
  await signInWithPassword(page, email);
  await expect(page.getByLabel('Sign-in code')).toBeVisible();
  await page.getByLabel('Sign-in code').fill(await codeSentTo(email, since));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page).not.toHaveURL(/sign-in/);
}

/** Partners sign in with a code to their phone (the delivery app is OTP-only). */
export async function signInWithOtp(page: Page, digits: string): Promise<void> {
  await page.goto('/sign-in');
  const since = Date.now() - 1000;
  await page.getByLabel('Mobile number').fill(digits);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill(await codeSentTo(`+91${digits}`, since));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).not.toHaveURL(/sign-in/);
}

/* ------------------------------ customer ordering ------------------------------ */

/**
 * Full-page loads restore the session by rotating the refresh cookie. Leaving the
 * page again before that response lands can lose the new cookie (the next load
 * then presents a rotated token and is signed out), so customer helpers wait for
 * the signed-in header first.
 */
export async function gotoSignedIn(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('link', { name: /^Notifications/ })).toBeVisible();
}

/** FR-LOC-004: deliver to coordinates (the precise way to pick a seeded zone). */
export async function setLocation(
  page: Page,
  place: { lat: number; lng: number },
  area: string,
): Promise<void> {
  await gotoSignedIn(page, '/location');
  await page.getByLabel('Latitude').fill(String(place.lat));
  await page.getByLabel('Longitude').fill(String(place.lng));
  await page.getByLabel('Area name').fill(area);
  await page.getByRole('button', { name: 'Use this location' }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Opens a restaurant from the discovery list (FR-DISC-001). */
export async function openRestaurant(page: Page, name: string, area: string): Promise<void> {
  await gotoSignedIn(page, '/');
  const card = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name, level: 3 }) })
    .filter({ hasText: area });
  await card.getByRole('link').click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

/** Adds a customisable dish through its options sheet (every dish the suite orders has one). */
export async function addDish(
  page: Page,
  dish: string,
  choose: (dialog: ReturnType<Page['getByRole']>) => Promise<void> = async () => {},
): Promise<void> {
  await page.getByRole('button', { name: `Add ${dish}` }).click();
  const dialog = page.getByRole('dialog', { name: dish });
  await expect(dialog.getByRole('button', { name: /^Add item/ })).toBeVisible();
  await choose(dialog);
  await dialog.getByRole('button', { name: /^Add item/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('link', { name: /View cart/ })).toBeVisible();
}

/** Checkout with a new saved address; returns at the payment step or the order page. */
export async function checkout(
  page: Page,
  options: {
    address: { lat: number; lng: number; area: string };
    tip?: string;
    method?: 'Pay online' | 'Cash on delivery';
  },
): Promise<void> {
  await gotoSignedIn(page, '/checkout');
  await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible();
  const form = page.getByRole('form', { name: 'New address' });
  if (
    !(await page
      .getByRole('radio', { name: /Home/ })
      .isVisible()
      .catch(() => false))
  ) {
    await page.getByRole('button', { name: 'Add address' }).click();
    await form.getByLabel('House / flat, building').fill('Flat 4B, Test Residency');
    await form.getByLabel('Area', { exact: true }).fill(options.address.area);
    await form.getByLabel('City').fill('Bengaluru');
    await form.getByLabel('State').fill('Karnataka');
    await form.getByLabel('PIN code').fill('560034');
    await form.getByLabel('Latitude').fill(String(options.address.lat));
    await form.getByLabel('Longitude').fill(String(options.address.lng));
    await form.getByRole('button', { name: 'Save address' }).click();
    await expect(form).toBeHidden();
  }
  if (options.tip) await page.getByRole('button', { name: options.tip, exact: true }).click();
  if (options.method === 'Cash on delivery')
    await page.getByRole('radio', { name: /Cash on delivery/ }).check();
  const place = page.getByRole('button', { name: /^Place order/ });
  await expect(place).toBeEnabled();
  await place.click();
}

/** Pays on the dev payment step with the chosen mock outcome. */
export async function pay(page: Page, outcome: 'Payment succeeds' | 'Payment fails') {
  await expect(page.getByRole('heading', { name: 'Complete payment' })).toBeVisible();
  await page.getByLabel('Test payment outcome').selectOption({ label: outcome });
  await page.getByRole('button', { name: /^(Pay ₹|Try again · ₹)/ }).click();
}

/** The order number shown on the tracking page ("Order FOS-… · Restaurant"). */
export async function orderNumber(page: Page): Promise<string> {
  const text = await page
    .getByText(/^Order \S+ · /)
    .first()
    .textContent();
  const number = text?.match(/^Order (\S+) ·/)?.[1];
  if (!number) throw new Error(`no order number in "${text}"`);
  return number;
}

/** Places a paid order end to end for a signed-in customer; returns its number and id. */
export async function placePaidOrder(
  page: Page,
  options: {
    place: { lat: number; lng: number };
    area: string;
    restaurantArea: string;
    dish?: string;
  },
): Promise<{ number: string; id: string }> {
  await setLocation(page, options.place, options.area);
  await openRestaurant(page, 'Saffron Handi Biryani', options.restaurantArea);
  await addDish(page, options.dish ?? 'Mutton Biryani');
  await checkout(page, { address: { ...options.place, area: options.area } });
  await pay(page, 'Payment succeeds');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    /Order placed — waiting for the restaurant/,
    { timeout: 30_000 },
  );
  const id = page.url().match(/\/orders\/([^/?#]+)/)![1]!;
  return { number: await orderNumber(page), id };
}

export interface Where {
  place: { lat: number; lng: number };
  area: string;
  restaurantArea: string;
}

export const KORAMANGALA: Where = {
  place: PLACES.koramangalaHome,
  area: 'Koramangala',
  restaurantArea: 'Koramangala',
};
export const INDIRANAGAR: Where = {
  place: PLACES.indiranagarHome,
  area: 'Indiranagar',
  restaurantArea: 'Indiranagar',
};

/** The customer's order details as the app loads them (refunds aren't shown on screen). */
export async function orderDetails(
  page: Page,
  orderId: string,
): Promise<{
  status: string;
  breakdown: { payable: number };
  payments: { status: string; amount: number }[];
  refunds: { amount: number; status: string; destination: string }[];
  cancellation: { feeAmount: number; refundAmount: number; reasonCode: string } | null;
}> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' && new URL(r.url()).pathname === `/api/v1/orders/${orderId}`,
    ),
    gotoSignedIn(page, `/orders/${orderId}`),
  ]);
  return ((await response.json()) as { data: Awaited<ReturnType<typeof orderDetails>> }).data;
}

/** A new signed-in customer with a paid order waiting for the restaurant. */
export async function customerWithOrder(
  browser: Browser,
  where: Where,
): Promise<Actor & { order: { number: string; id: string } }> {
  const actor = await openApp(browser, 'customer');
  await createCustomer(actor);
  const order = await placePaidOrder(actor.page, where);
  return { ...actor, order };
}

/* ------------------------------ restaurant ------------------------------ */

/** The Saffron Handi Biryani owner, on the order queue of one outlet. */
export async function restaurantQueue(browser: Browser, outlet: string): Promise<Actor> {
  const actor = await openApp(browser, 'restaurant');
  await signInStaff(actor.page, '+919000000201');
  await actor.page.goto('/orders');
  await actor.page.getByLabel('Outlet').selectOption({ label: outlet });
  await expect(actor.page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible();
  return actor;
}

/** Accepts a new order (15 min or less, so dispatch starts at once). */
export async function acceptOrder(page: Page, number: string, prepMinutes = '15'): Promise<void> {
  await queueTab(page, 'New');
  const card = orderCard(page, number);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByLabel('Prep time (minutes)').fill(prepMinutes);
  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(card).toBeHidden();
}

/** The order's card in the restaurant queue (FR-RORD-008). */
export const orderCard = (page: Page, number: string) =>
  page.getByRole('article', { name: `Order ${number}` });

/** Opens the queue tab with the given label ("New", "Preparing", …). */
export async function queueTab(page: Page, label: string): Promise<void> {
  await page.getByRole('tab', { name: new RegExp(`^${label}\\b`) }).click();
}

/* ------------------------------ partner ------------------------------ */

export async function goOnline(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your shift' })).toBeVisible();
  const ack = page.getByRole('button', { name: 'I have read and agree' });
  if (await ack.isVisible().catch(() => false)) await ack.click();
  const online = page.getByRole('button', { name: 'Go online' });
  const offline = page.getByRole('button', { name: 'Go offline' });
  await expect(online.or(offline)).toBeVisible();
  if (await online.isVisible()) await online.click();
  await expect(page.getByText('Online — waiting for orders')).toBeVisible();
}

export async function goOffline(page: Page): Promise<void> {
  await page.goto('/');
  const off = page.getByRole('button', { name: 'Go offline' });
  if (await off.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await off.click();
    await expect(page.getByRole('button', { name: 'Go online' })).toBeVisible();
  }
}

/**
 * Moves a partner's phone (Playwright geolocation) to a place and waits out the
 * app's position cache (`maximumAge: 10 s`), as the ride itself would.
 */
export async function moveTo(actor: Actor, place: { lat: number; lng: number }): Promise<void> {
  await actor.context.setGeolocation({ latitude: place.lat, longitude: place.lng, accuracy: 10 });
  await actor.page.waitForTimeout(10_500);
}

export const offerCard = (page: Page) => page.getByRole('region', { name: 'New order offer' });

/* ------------------------------ accessibility ------------------------------ */

/**
 * AC-NFR-002: no serious or critical axe violations (WCAG 2.x A/AA). A soft check,
 * so a journey goes on and reports every page's violations at the end.
 */
export async function expectAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect
    .soft(
      blocking.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
      })),
      `accessibility of ${label}`,
    )
    .toEqual([]);
}

export { CLIENT_APP };
