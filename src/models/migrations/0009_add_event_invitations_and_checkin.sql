-- Migration 0009: Add Event Invitations, Guests, Check-in, Readers, Deliveries and Audit Logs

-- 1. Extend users with platform role
ALTER TABLE users ADD COLUMN IF NOT EXISTS role varchar(50) DEFAULT 'user' NOT NULL;

-- 2. Extend events table with invitation management fields
ALTER TABLE events ADD COLUMN IF NOT EXISTS category varchar(100);
ALTER TABLE events ADD COLUMN IF NOT EXISTS start_at timestamp with time zone;
ALTER TABLE events ADD COLUMN IF NOT EXISTS end_at timestamp with time zone;
ALTER TABLE events ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS capacity integer;
ALTER TABLE events ADD COLUMN IF NOT EXISTS cover_image text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS background_image text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS status varchar(50) DEFAULT 'published' NOT NULL;
ALTER TABLE events ADD COLUMN IF NOT EXISTS max_entries_per_invitation integer DEFAULT 1 NOT NULL;

-- 3. Event Users (Collaborators / Co-organizers)
CREATE TABLE IF NOT EXISTS event_users (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(50) NOT NULL DEFAULT 'admin',
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS event_users_event_id_idx ON event_users(event_id);
CREATE INDEX IF NOT EXISTS event_users_user_id_idx ON event_users(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS event_users_event_user_idx ON event_users(event_id, user_id);

-- 4. Event Guests
CREATE TABLE IF NOT EXISTS event_guests (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  email varchar(255),
  phone varchar(50),
  category varchar(100) DEFAULT 'Convidado' NOT NULL,
  notes text,
  external_id varchar(100),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS event_guests_event_id_idx ON event_guests(event_id);
CREATE INDEX IF NOT EXISTS event_guests_email_idx ON event_guests(event_id, email);
CREATE INDEX IF NOT EXISTS event_guests_phone_idx ON event_guests(event_id, phone);

-- 5. Event Invitations (Individual QR Code invitations)
CREATE TABLE IF NOT EXISTS event_invitations (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_id integer NOT NULL REFERENCES event_guests(id) ON DELETE CASCADE,
  token_hash varchar(64) NOT NULL,
  status varchar(50) DEFAULT 'pending' NOT NULL,
  max_entries integer DEFAULT 1 NOT NULL,
  used_entries integer DEFAULT 0 NOT NULL,
  valid_from timestamp with time zone,
  valid_until timestamp with time zone,
  issued_at timestamp with time zone,
  revoked_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS event_invitations_token_hash_idx ON event_invitations(token_hash);
CREATE INDEX IF NOT EXISTS event_invitations_event_id_idx ON event_invitations(event_id);
CREATE INDEX IF NOT EXISTS event_invitations_guest_id_idx ON event_invitations(guest_id);
CREATE INDEX IF NOT EXISTS event_invitations_status_idx ON event_invitations(status);

-- 6. Event Readers (Authorized QR Code validation operators)
CREATE TABLE IF NOT EXISTS event_readers (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS event_readers_event_id_idx ON event_readers(event_id);
CREATE INDEX IF NOT EXISTS event_readers_user_id_idx ON event_readers(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS event_readers_event_user_idx ON event_readers(event_id, user_id);

-- 7. Event Checkins (Validation logs & real-time entry tracking)
CREATE TABLE IF NOT EXISTS event_checkins (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  invitation_id integer NOT NULL REFERENCES event_invitations(id) ON DELETE CASCADE,
  guest_id integer NOT NULL REFERENCES event_guests(id) ON DELETE CASCADE,
  reader_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  device_identifier varchar(255),
  checked_in_at timestamp with time zone DEFAULT now() NOT NULL,
  result varchar(50) NOT NULL
);

CREATE INDEX IF NOT EXISTS event_checkins_event_id_idx ON event_checkins(event_id);
CREATE INDEX IF NOT EXISTS event_checkins_invitation_id_idx ON event_checkins(invitation_id);
CREATE INDEX IF NOT EXISTS event_checkins_guest_id_idx ON event_checkins(guest_id);
CREATE INDEX IF NOT EXISTS event_checkins_reader_user_id_idx ON event_checkins(reader_user_id);
CREATE INDEX IF NOT EXISTS event_checkins_checked_in_at_idx ON event_checkins(checked_in_at);

-- 8. Invitation Deliveries (Email and WhatsApp dispatch logs)
CREATE TABLE IF NOT EXISTS invitation_deliveries (
  id serial PRIMARY KEY,
  invitation_id integer NOT NULL REFERENCES event_invitations(id) ON DELETE CASCADE,
  channel varchar(50) NOT NULL,
  destination varchar(255) NOT NULL,
  status varchar(50) DEFAULT 'pending' NOT NULL,
  provider_message_id varchar(255),
  attempts integer DEFAULT 0 NOT NULL,
  error_message text,
  sent_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS invitation_deliveries_invitation_id_idx ON invitation_deliveries(invitation_id);
CREATE INDEX IF NOT EXISTS invitation_deliveries_channel_status_idx ON invitation_deliveries(channel, status);

-- 9. Event Audit Logs
CREATE TABLE IF NOT EXISTS event_audit_logs (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  action varchar(100) NOT NULL,
  entity_type varchar(100) NOT NULL,
  entity_id integer,
  metadata jsonb,
  ip_address varchar(45),
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS event_audit_logs_event_id_idx ON event_audit_logs(event_id);
CREATE INDEX IF NOT EXISTS event_audit_logs_user_id_idx ON event_audit_logs(user_id);
CREATE INDEX IF NOT EXISTS event_audit_logs_action_idx ON event_audit_logs(action);
CREATE INDEX IF NOT EXISTS event_audit_logs_created_at_idx ON event_audit_logs(created_at);

