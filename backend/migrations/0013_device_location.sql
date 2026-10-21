-- Where each signed-in device is (Security page, admin only).
--   lat / lng / accuracy_m / located_at: the device's GPS fix, sent by the app while it is used.
--   city / region / country: Cloudflare's network estimate at sign-in (needs the free
--   "Add visitor location headers" Managed Transform; see DEPLOY.md).
-- Rows are removed with the session history (90 days after the device signs out).
ALTER TABLE sessions ADD COLUMN lat REAL CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90));
ALTER TABLE sessions ADD COLUMN lng REAL CHECK (lng IS NULL OR (lng >= -180 AND lng <= 180));
ALTER TABLE sessions ADD COLUMN accuracy_m INTEGER CHECK (accuracy_m IS NULL OR accuracy_m >= 0);
ALTER TABLE sessions ADD COLUMN located_at TEXT;
ALTER TABLE sessions ADD COLUMN city TEXT CHECK (city IS NULL OR length(city) <= 80);
ALTER TABLE sessions ADD COLUMN region TEXT CHECK (region IS NULL OR length(region) <= 80);
ALTER TABLE sessions ADD COLUMN country TEXT CHECK (country IS NULL OR length(country) <= 8);
