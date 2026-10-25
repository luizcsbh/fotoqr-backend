DROP TABLE IF EXISTS credentials;

ALTER TABLE users
  DROP COLUMN IF EXISTS google_id;

UPDATE events
SET storage_mode = 'fallback';

ALTER TABLE events
  DROP COLUMN IF EXISTS google_album_id;

ALTER TABLE events
  ALTER COLUMN storage_mode DROP DEFAULT;

ALTER TABLE events
  ALTER COLUMN storage_mode TYPE TEXT
  USING storage_mode::TEXT;

DROP TYPE storage_mode;

CREATE TYPE storage_mode AS ENUM ('fallback');

ALTER TABLE events
  ALTER COLUMN storage_mode TYPE storage_mode
  USING storage_mode::storage_mode;

ALTER TABLE events
  ALTER COLUMN storage_mode SET DEFAULT 'fallback';
