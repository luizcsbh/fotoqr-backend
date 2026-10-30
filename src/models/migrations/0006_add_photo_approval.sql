DO $$ BEGIN
  CREATE TYPE public.photo_review_status AS ENUM('approved', 'pending');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Existing photos were already public, so they start as approved
ALTER TABLE photos ADD COLUMN IF NOT EXISTS review_status public.photo_review_status DEFAULT 'approved' NOT NULL;
CREATE INDEX IF NOT EXISTS photos_review_status_idx ON photos(event_id, review_status);

ALTER TABLE events ADD COLUMN IF NOT EXISTS require_photo_approval boolean DEFAULT false NOT NULL;
