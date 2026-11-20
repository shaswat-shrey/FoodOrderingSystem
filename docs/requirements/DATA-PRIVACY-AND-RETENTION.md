# SRS Section 20 — Data Privacy and Retention

> Part of FOS-SRS-001 v0.10.0 (APPROVED 2026-11-20). **This section is an engineering proposal, not legal advice.** The platform does not claim compliance with any law or certification. Items marked ⚖ require review by qualified legal counsel before launch in India.

## 20.1 Applicable regulatory areas (India) ⚖

| Area | Relevance | Engineering implication (to be confirmed by counsel) |
|---|---|---|
| Digital Personal Data Protection Act, 2023 and rules notified under it | Platform is a Data Fiduciary for customers, restaurant members, partners. | Notice & consent at collection; purpose limitation; data principal rights (access, correction, erasure, grievance); breach notification process; retention limited to purpose; children's data (platform not intended for under-18 — age gate in terms; partners must be ≥ 18); possible Significant Data Fiduciary obligations at scale. |
| Information Technology Act, 2000 & rules (incl. reasonable security practices) | Security of sensitive personal data (financial info, passwords). | Encryption, access controls, audit logs, incident response. |
| Consumer Protection (E-Commerce) Rules, 2020 | Marketplace e-commerce entity obligations. | Seller (restaurant) details display, grievance officer, price transparency (all fees shown before payment), cancellation/refund policy disclosure, no manipulative pricing. |
| CGST Act §9(5) & GST invoicing rules | Platform may be liable to collect GST on restaurant services. | Configurable tax engine; invoice issuance; tax reports. |
| Income-tax (TDS on e-commerce, §194-O) / GST TCS | Withholding on payouts to restaurants. | Settlement deductions lines; reports. |
| FSSAI regulations for e-commerce FBOs | Restaurant licence verification and display. | Mandatory FSSAI on onboarding & display (BR-REST-005/010). |
| RBI: payment aggregator rules, storage of payment system data, PPI directions | Payments via licensed PA; wallet scope. | No card storage; closed-loop credits only (BR-WALLET-001); payment data stored in India (choose India region hosting — OD-12). |
| Labour codes (Code on Social Security, 2020 — gig/platform workers) | Delivery partners as platform workers. | Data needed for welfare schemes/registration may be required; partner earnings records retained. |
| Motor Vehicles Act | Partner licence/vehicle validity. | DL/RC verification and expiry tracking. |

## 20.2 Data inventory, access and retention

| Data category | Examples | Who can access | Retention (proposed ⚖) | Deletion / anonymization |
|---|---|---|---|---|
| User profile | Name, email, phone, avatar, preferences | User; support/admin (masked by default) | Account lifetime | On deletion (after 30-day grace): name → "Deleted user", email/phone → salted hash tombstone (for fraud/duplicate prevention), avatar deleted |
| Authentication data | Password hash, sessions, refresh-token hashes, OTP hashes, login attempts | System only; admins see session metadata | Sessions: 30 d after end; OTPs 7 d; login attempts 90 d | Purged by JOB-AUTH-001 |
| Addresses | Saved addresses with coordinates | Customer; partner sees only the order's snapshot during delivery; support for order context | Until deleted by user / account deletion | Hard-deleted on account anonymization (order snapshots coarsened — see Orders) |
| Customer location (session) | Coordinates used for discovery | Not stored server-side beyond request logs (coarsened) | Request logs 30 d with coordinates rounded to 3 decimals | — |
| Partner location history | Trail during active deliveries; last-known location | Ops/admin with `partner:location` (audited); customer only live during own delivery | Raw trail 90 d; aggregated distance per delivery retained with earnings | Partition drop after 90 d |
| Orders | Items, prices, address snapshot, contact | Customer; restaurant (minimized projection); partner (during delivery); support/admin | 8 years (financial/tax) ⚖ | After 3 years: contact name → initials, phone removed, address coarsened to area/pincode; financial fields retained |
| Payments & refunds | Amounts, provider IDs, masked instrument | Customer (own); finance admins | 8 years ⚖ | Never stores card data; instrument summary masked at source |
| Ledger, settlements, payouts, invoices | Financial records | Finance admins; owners/partners (own) | 8 years ⚖ | Retained (legal obligation) |
| Restaurant & partner KYC documents | FSSAI, PAN, DL, RC, bank proof | Owner/partner; reviewers with `document:read` (audited) | While account active + 1 year after closure ⚖ (longer if under dispute) | Object deletion + metadata tombstone |
| Bank details | Account number (encrypted), IFSC | Owner/partner (masked); finance with reveal (audited) | Account lifetime + 8 years for payout records ⚖ | Encrypted; key rotation |
| Delivery proofs | Door photos | Customer (own), support, admin | 30 days (OD-16) | Auto-delete |
| Reviews | Ratings, text, photos | Public (published), author | Account lifetime; on deletion → author shown as "Deleted user", text retained unless user requests removal | Soft/hard delete on request |
| Support conversations | Messages, attachments | Requester, support | 3 years after closure | Purge attachments after 1 year |
| Notifications | In-app inbox, delivery logs | Recipient; ops | Inbox 180 d; delivery logs 90 d | Purge |
| Logs (application) | Structured logs (PII-redacted) | Engineering/ops | 30 d hot, 90 d archive | Expire |
| Audit logs | Admin/security actions | Super admins, auditors | 3 years online + archive to 8 years for financial actions ⚖ | Append-only; archive |
| Analytics aggregates | Counts/metrics | Admins, restaurants (own) | Indefinite (non-personal aggregates) | — |
| Search history | Queries | User | 180 d or until cleared | Purge |

## 20.3 Privacy requirements

| ID | Requirement |
|---|---|
| PRIV-001 | Privacy notice presented at registration (each app) describing purposes, categories, retention, rights, grievance contact; acceptance recorded (BR-AUTH-020). |
| PRIV-002 | Location permission requested contextually with explanation; customers can always use manual location instead. |
| PRIV-003 | Partners are informed that location is collected only while online; the app shows a persistent indicator while tracking. |
| PRIV-004 | Data minimization projections per role (NFR-PRIV-001); kitchen staff see no customer data. |
| PRIV-005 | Customer phone shared with partner only for the active delivery (masked calling in ADV); partner phone never shown to customers in MVP (calls via partner app → customer only; customer → support). |
| PRIV-006 | Data export (FR-CUST-008) and deletion (FR-AUTH-041) workflows complete within 72 h (export) / 30 days (deletion after grace). |
| PRIV-007 | Breach response runbook: detection → containment → assessment → notification to affected users and authorities as required by law ⚖ → post-mortem. |
| PRIV-008 | Third-party processors (payment, SMS, email, maps, storage, error tracking) are listed in the privacy notice; only minimum necessary data shared (e.g., error tracking scrubs PII). |
| PRIV-009 | Test and development environments never use production personal data; seed data is synthetic. |
| PRIV-010 | Data residency: production data hosted in an India region (pending OD-12 confirmation) to simplify payment-data localization obligations. |

## 20.4 Items requiring legal review (summary) ⚖

1. Retention periods for orders/financial records (proposed 8 years) and KYC documents.
2. GST treatment of food (e-commerce operator liability) and fees; invoice issuance responsibilities.
3. TCS/TDS deductions on restaurant settlements.
4. Customer wallet credits under RBI PPI rules (closed-loop scope, expiry).
5. DPDP consent language, children/age gating, grievance officer, breach notification timelines.
6. Consumer Protection (E-Commerce) Rules disclosures (seller information, fee transparency, cancellation policy).
7. Delivery photo proof legality and retention.
8. Partner background verification requirements and gig-worker obligations.
