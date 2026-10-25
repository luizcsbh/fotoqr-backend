ALTER TABLE users
  ALTER COLUMN google_id DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_password_email_unique_idx
  ON users (lower(email))
  WHERE password_hash IS NOT NULL;
