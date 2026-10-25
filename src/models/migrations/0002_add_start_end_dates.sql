-- Add start_date and end_date columns to events table
ALTER TABLE events ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS end_date TIMESTAMPTZ;

-- Backfill start_date from event_date if null
UPDATE events SET start_date = event_date WHERE start_date IS NULL AND event_date IS NOT NULL;
