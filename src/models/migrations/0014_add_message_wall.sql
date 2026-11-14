-- Guest message wall ("Mural de recados"). Also applied at startup by src/config/ensureSchema.ts.
ALTER TABLE events ADD COLUMN IF NOT EXISTS enable_message_wall boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS event_messages (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_name varchar(80) NOT NULL,
  guest_phone varchar(20) NOT NULL,
  message text NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS event_messages_event_created_idx ON event_messages(event_id, created_at);
