# Payment Architecture

> Phase 1 · v0.5.1 (APPROVED 2026-11-20). Requirements: SRS §11 (FR-PAY-*, FR-REFUND-*, FR-RECON-*, FR-SETTLE-*). Decisions: ADR-007 (money), ADR-011 (ledger).

## 1. Components

```mermaid
flowchart LR
  CHK[checkout] -->|create order + payment| PAY[payments service]
  PAY --> ADP{{PaymentProvider adapter}}
  ADP --> RZP[RazorpayProvider]
  ADP --> MOCK[MockProvider]
  ADP -.-> STR[StripeProvider (ADV)]
  WH[/POST /payments/webhooks/:provider/] --> EVT[(payment_webhook_events)]
  EVT --> JOB[JOB-PAY-001 processor]
  JOB --> PAY
  PAY --> ORD[orders.transition]
  PAY --> LED[wallet / ledger service]
  REF[refunds service] --> ADP
  REF --> LED
  REC[reconciliation job] --> ADP
  REC --> LED
```

## 2. Adapter interface (TypeScript sketch)

```ts
export interface PaymentProvider {
  readonly name: 'RAZORPAY' | 'STRIPE' | 'MOCK';
  createPaymentOrder(input: { paymentId: string; amount: number; currency: 'INR'; receipt: string; notes: Record<string,string> }): Promise<{ providerOrderId: string; clientParams: Record<string, unknown> }>;
  getPaymentOrder(providerOrderId: string): Promise<ProviderOrderStatus>;
  getPayment(providerPaymentId: string): Promise<ProviderPayment>;
  verifyClientCallback(input: unknown): boolean;                    // signature check, no network
  verifyWebhook(rawBody: Buffer, headers: Record<string,string>): boolean;
  parseWebhook(rawBody: Buffer): NormalizedPaymentEvent;            // provider → canonical event
  refund(input: { providerPaymentId: string; amount: number; refundId: string; notes?: Record<string,string> }): Promise<{ providerRefundId: string; status: 'PENDING' | 'PROCESSED' | 'FAILED' }>;
  getRefund(providerRefundId: string): Promise<ProviderRefund>;
  listSettlements?(date: string): Promise<ProviderSettlement[]>;
}
```
Canonical events: `PAYMENT_AUTHORIZED`, `PAYMENT_CAPTURED`, `PAYMENT_FAILED`, `ORDER_PAID`, `REFUND_PROCESSED`, `REFUND_FAILED` — the payments service only understands canonical events, so adding Stripe means writing an adapter, not changing business logic.

## 3. Money representation
Integer paise everywhere (`integer` for per-transaction amounts and `bigint` for balances/totals in DB — DB-CONV-005, `number` in TS guarded ≤ `Number.MAX_SAFE_INTEGER` — ₹90 trillion, ample), currency on aggregates. Percentages in basis points. One rounding function. Formatting only at the edge.

## 4. Ledger (double entry)

Every financial event is a `ledger_transaction` whose entries sum to zero. Positive = debit, negative = credit (convention documented in code). Examples (amounts in ₹ for readability):

**Online order paid ₹500 (food 400, packaging 20, delivery 29, platform fee 5, taxes 26, tip 20):**

| Account | Amount |
|---|---|
| GATEWAY_CLEARING (asset: money held by gateway) | +500 |
| CUSTOMER_ORDER_LIABILITY (order:{id}) | −500 |

**On DELIVERED (settlement split, commission 20 % of 420 = 84, GST on commission omitted for brevity):**

| Account | Amount |
|---|---|
| CUSTOMER_ORDER_LIABILITY | +500 |
| RESTAURANT_PAYABLE (restaurant:{id}) | −336 (420 − 84) |
| PLATFORM_REVENUE_COMMISSION | −84 |
| PLATFORM_REVENUE_FEES | −34 (29 + 5) |
| TAX_PAYABLE | −26 |
| PARTNER_PAYABLE (tip) | −20 |

**Partner earnings ₹45 for the trip:** PLATFORM_DELIVERY_COST +45 / PARTNER_PAYABLE −45.

**Refund ₹100 to source (restaurant fault):** RESTAURANT_PAYABLE +100 / GATEWAY_CLEARING −100 (after provider confirms; PROCESSING uses REFUND_CLEARING).

**Wallet credit ₹50 goodwill:** PLATFORM_REFUND_EXPENSE +50 / CUSTOMER_WALLET −50.

**COD order collected ₹300:** PARTNER_CASH_IN_HAND +300 / CUSTOMER_ORDER_LIABILITY −300; remittance: CASH_CLEARING +300 / PARTNER_CASH_IN_HAND −300.

**Payout ₹10,000 to restaurant:** RESTAURANT_PAYABLE +10,000 / PAYOUT_CLEARING −10,000; on bank confirmation PAYOUT_CLEARING +10,000 / BANK −10,000.

(The final chart of accounts and tax treatment are validated with a finance/tax advisor before CORE — OD-05/06.)

Invariants (JOB-LEDGER-001): Σ per transaction = 0; customer wallet ≥ 0; order liability returns to 0 when an order reaches a terminal state and all refunds settle; gateway clearing reconciles with provider settlements.

## 5. Idempotency layers
1. HTTP `Idempotency-Key` on initiation/verify/refund endpoints.
2. Deterministic provider references (receipt = order number; refund notes = refund ID) and pre-create lookup.
3. DB uniqueness: `(provider, provider_order_id)`, `provider_payment_id`, `(provider, event_id)`, `provider_refund_id`, ledger transaction `(type, reference)`.
4. State precedence on payments (no downgrades).

## 6. Security
Hosted checkout (no card data on our servers, PCI scope minimal), client gets only key ID; signature verification with timing-safe comparison; webhook raw-body HMAC; secrets from env/secret manager; amount & currency assertions; provider IPs optionally allowlisted at the edge (defense in depth, not relied upon).

## 7. Reconciliation
Daily: fetch provider payments/refunds/settlements for D-1 → match by provider IDs → classify exceptions (missing internal, missing provider, amount mismatch, status mismatch, orphan capture) → admin queue. Hourly: resolve stuck PENDING/AUTHORIZED payments.

## 8. Testing
MockProvider scenarios selected by test card/VPA (e.g., `success@mock`, `fail@mock`, `delay60@mock`, `dup_webhook@mock`, `out_of_order@mock`, `amount_mismatch@mock`) so E2E and integration tests cover every edge case deterministically; Razorpay test mode in staging.
