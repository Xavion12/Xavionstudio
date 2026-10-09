-- GST is included in every plan price (default 5%: CGST 2.5% + SGST 2.5%).
-- Each payment keeps the rate in force when it was made, so changing the rate later never
-- rewrites old receipts. NULL (payments from before this migration) = the current rate.
ALTER TABLE payments ADD COLUMN gst_rate INTEGER CHECK (gst_rate IS NULL OR (gst_rate >= 0 AND gst_rate <= 28));

INSERT INTO settings (key, value) VALUES ('gst_rate', '5')
    ON CONFLICT (key) DO UPDATE SET value = '5', updated_at = datetime('now') WHERE value = '0';
