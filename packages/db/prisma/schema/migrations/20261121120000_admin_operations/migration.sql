-- API-ADM-065 (FR-ADMIN-041): ops may extend an order's acceptance window once.
ALTER TABLE "orders" ADD COLUMN "accept_extended_until" TIMESTAMPTZ(3);

-- BR-EARN-006: unremitted cash in hand netted off a partner payout line.
ALTER TABLE "payouts" ADD COLUMN "cash_deduction" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE payouts ADD CONSTRAINT payouts_cash_deduction_chk CHECK (cash_deduction >= 0);

-- BR-ADMIN-001 / FR-SETTLE-003: the approver of a payout batch is never its maker.
ALTER TABLE payout_batches ADD CONSTRAINT payout_batches_maker_checker_chk
  CHECK (approved_by IS NULL OR created_by IS NULL OR approved_by <> created_by);
