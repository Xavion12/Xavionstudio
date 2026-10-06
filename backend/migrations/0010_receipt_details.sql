-- Xavion Fitness · 0010 · Receipt details
-- The plan's price at the moment of payment, so a receipt can show the discount even after the
-- plan's price changes. Filled by every new payment; older payments keep NULL (no discount line).
ALTER TABLE payments ADD COLUMN list_price INTEGER CHECK (list_price IS NULL OR list_price >= 0);
