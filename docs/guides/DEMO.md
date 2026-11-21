# Demo accounts and walkthrough

Everything here uses the **development seed** (`pnpm --filter @fos/db db:seed`, data in [`packages/db/src/seed/data.ts`](../../packages/db/src/seed/data.ts)). All people, phone numbers (`+91 90000 00xxx`) and restaurants are fictional; emails use `example.com`. Never load the seed into production.

## 1. Before you start

```bash
pnpm --filter @fos/db db:seed      # resets the database to the demo data
pnpm dev                           # API 4000, worker, apps 5173–5176
tail -f .local/dev-messages.log    # every OTP, emailed code and email link appears here
```

- The worker must be running: it delivers codes, relays order events, dispatches partners and runs timers.
- Restaurants are open on their seeded hours (most outlets 11:30–23:30 IST). Outside them, change the outlet's hours in the restaurant app (**Outlet → Hours**) or pick another restaurant.
- Use **separate browser profiles or windows** (or one normal + one private window per app) so each app keeps its own session.
- Codes expire after a few minutes and a number can request a new one every 30 s.

## 2. Accounts

### Customers (customer app, http://localhost:5173)

| Name | Phone | Notes |
| --- | --- | --- |
| Asha Rao | `9000000101` (+91) | Home in Koramangala, work in Indiranagar |
| Rahul Verma | `9000000102` | Home in HSR Layout, veg-only preference |

Any other number signs up as a new customer (try `9000000999`): `WELCOME50` then applies to the first order.

### Restaurant staff (restaurant app, http://localhost:5174)

| Name | Phone | Role |
| --- | --- | --- |
| Imran Sheikh | `9000000201` | Owner, Saffron Handi Biryani (Koramangala and Indiranagar outlets) |
| Deepa Kulkarni | `9000000301` | Manager, Saffron Handi Biryani (all outlets) |
| Suresh Kumar | `9000000302` | Kitchen, Saffron Handi Biryani (Koramangala only) — kitchen display, no prices |
| Lakshmi Bhat | `9000000202` | Owner, Banana Leaf Udupi Kitchen |
| Gurpreet Singh | `9000000203` | Owner, Clay Oven Chronicles |
| Kenji Lepcha | `9000000204` | Owner, Lantern Lane Wok |
| Sarah Fernandes | `9000000205` | Owner, Ember & Crust Pizzeria |
| Ananya Ghosh | `9000000206` | Owner, Sugar Spoon Desserts |
| Rohan Mehta | `9000000207` | Owner, Leaf Ledger Bowls |
| Vikram Joshi | `9000000208` | Owner, Kettle & Kulhad |

A number without a restaurant gets the restaurant application form after signing in.

### Delivery partners (delivery app, http://localhost:5175)

| Name | Phone | Vehicle | Zone (starting point) |
| --- | --- | --- | --- |
| Manjunath Gowda | `9000000401` | Motorcycle | South (Koramangala, `12.933, 77.628`) |
| Ravi Shankar | `9000000402` | Scooter | South (HSR, `12.914, 77.637`) |
| Pooja Hegde | `9000000403` | E-bike | South (`12.927, 77.619`) |
| Abdul Rahman | `9000000404` | Motorcycle | East (Indiranagar, `12.970, 77.642`) |
| Santosh Patil | `9000000405` | Scooter | East (`12.976, 77.651`) |
| Nisha Thomas | `9000000406` | Bicycle (short trips only) | East (`12.979, 77.638`) |

A number without a partner profile gets the partner application.

### Platform staff (admin console, http://localhost:5176)

| Name | Email | Phone | Role |
| --- | --- | --- | --- |
| Meera Iyer | `superadmin@example.com` | `9000000001` | Super admin (roles, everything) |
| Arjun Nair | `admin@example.com` | `9000000002` | Admin |
| Kavya Reddy | `support@example.com` | `9000000003` | Support agent (support desk, limited refunds) |

## 3. How to sign in

**Customer, restaurant and delivery apps — phone code.** Enter the 10-digit number (the apps add +91), press **Send code**, copy the 6-digit code for that number from `.local/dev-messages.log`, enter it.

**Admin console — password + emailed code.** Seed accounts have no passwords, and the admin console accepts no phone codes:

1. On the admin sign-in page choose **Forgot password?** and enter `admin@example.com`.
2. Open the reset link for that address from `.local/dev-messages.log` (it points at `http://localhost:5176/reset-password?token=…`) and choose a password (at least 8 characters, not a common or breached password).
3. Sign in with the email and the new password; the console asks for a code — read the newest "Your verification code" email for that address in the log.

Restaurant staff and customers can set a password the same way (their app's **Forgot password?**) and then sign in with phone or email + password; the delivery app is phone-code only.

## 4. Fifteen-minute walkthrough

Four windows side by side: customer (Asha), restaurant (Deepa, manager), delivery (Manjunath), admin (Arjun). Timings are approximate.

### 0:00 — Admin: the control room (2 min)

1. Sign in as `admin@example.com` (see §3; do the password reset before the demo).
2. **Dashboard**: today's orders, live ops feed, alerts. **Zones**: the two Bengaluru zones on the map, surge settings. **Pricing**: fee schedule with distance slabs, tax rules, commission plan — all effective-dated and append-only.
3. Leave the **Orders** screen open; new orders appear live.

### 2:00 — Delivery: go online (1 min)

1. Sign in as `9000000401`. Allow location; in Chrome DevTools → **Sensors** set the location to `12.933, 77.628` (Koramangala) so the partner is inside the South zone.
2. Acknowledge the guidelines if asked, then **Go online**. The shift screen shows today's stats and waits for offers.

### 3:00 — Customer: find food and order (4 min)

1. Sign in as `9000000101`. Choose the saved **Home** address (Koramangala).
2. Home shows serviceable restaurants with ETA and fees; try filters (veg only, rating) and search "biriyani" (typo tolerated).
3. Open **Saffron Handi Biryani — Koramangala**, add **Chicken Dum Biryani** (pick **Family pack** and an add-on), open the cart, apply `FLAT100` (needs ₹499+) — the bill updates with item total, packaging, delivery fee, platform fee, taxes and discount.
4. **Checkout**: add a ₹20 tip, choose **Pay online** and place the order. The payment step is the development provider: choose **Payment succeeds**. (Choose **Payment fails** first to show the retry, or pay **Cash on delivery**.)
5. The order page shows **Order placed** with a live timeline and the delivery code.

### 7:00 — Restaurant: accept and cook (3 min)

1. Deepa (`9000000301`) is on **Orders** for the Koramangala outlet: the new order arrives with a repeating sound alert.
2. **Accept** with a prep time of **15 minutes or less** — dispatch then starts at once (with a longer prep time the first offer waits until shortly before the food is ready). The customer's timeline moves to **Accepted** instantly.
3. Open the **Kitchen** display (or sign in as Suresh, `9000000302`, in another window): the ticket shows items and options, no prices. Mark **Preparing**, then **Ready**.
4. Meanwhile show **Menu** (toggle a dish out of stock — it disappears from the customer menu at once), **Outlet** (pause for 15 minutes, rush mode), **Dashboard** and **Analytics**.

### 10:00 — Delivery: the trip (3 min)

1. The partner receives the offer with pickup/drop distances, earnings and a 30 s countdown — **Accept**. The customer now sees the partner's name and vehicle.
2. **Arrived at restaurant**. Hand over: either the partner taps **Picked up** once the order is ready, or the restaurant enters the partner's pickup code in the order details (**Handover**).
3. Move the DevTools location towards Asha's home (`12.9352, 77.6245`); the customer's map follows the partner with an updated ETA.
4. **Arrived at customer**, enter the 4-digit delivery code shown on the customer's order page, **Complete**. For a cash order the app first asks to confirm the cash collected.
5. Show **Earnings**: the trip's base, distance and tip; cash in hand; next payout estimate.

### 13:00 — Customer after-care and admin oversight (2 min)

1. Customer: the order is **Delivered**; download the invoice, rate the restaurant and the partner, **Reorder**, and look at **Wallet** and **Notifications**.
2. Admin: open the order in **Orders** — the 360 view with status history, payments, the delivery's stage events and the audit trail. Show **Dispatch** (live board), **Refunds** (issue a partial refund with a reason — it lands in the customer's wallet or original method), **Support** desk, **Approvals** and **Audit log**.

### Optional extras

- **Onboarding**: sign in to the restaurant app with a new number, fill the application with documents, submit; approve it in the admin console (**Approvals**) and sign in again as the new owner.
- **Failure paths**: restaurant **Reject** (customer is refunded automatically); partner declines the offer (the next partner gets it); customer cancels after the free window (fee preview, partial refund); no partner online (escalation on the admin dispatch board).
- **Cancellation by ops**: admin **Orders → Cancel** with fault attribution and the resulting refund.

## 5. Resetting

`pnpm --filter @fos/db db:seed` restores the demo data (it truncates every table, including orders made during the demo). Partners left online are taken offline by the inactivity sweep, or from the admin console (**Partners → Force offline**). Clear `.local/dev-messages.log` whenever you like.
