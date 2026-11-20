-- BR-CART-005: remember the unit price shown, so price changes are flagged.
ALTER TABLE "cart_items" ADD COLUMN "unit_amount_seen" INTEGER;
ALTER TABLE cart_items ADD CONSTRAINT cart_items_unit_amount_seen_chk CHECK (unit_amount_seen IS NULL OR unit_amount_seen >= 0);
