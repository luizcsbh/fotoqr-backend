DO $$ BEGIN
  CREATE TYPE public.music_request_status AS ENUM('pending', 'approved', 'rejected', 'played');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS music_requests (
  id serial PRIMARY KEY NOT NULL,
  event_id integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  spotify_track_id varchar(64),
  title varchar(255) NOT NULL,
  artist varchar(255) NOT NULL,
  album_name varchar(255),
  album_art_url text,
  spotify_preview_url text,
  guest_name varchar(100),
  status public.music_request_status DEFAULT 'pending' NOT NULL,
  position integer DEFAULT 0 NOT NULL,
  requested_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS music_requests_event_id_idx ON music_requests(event_id);
CREATE INDEX IF NOT EXISTS music_requests_status_idx ON music_requests(status);
CREATE UNIQUE INDEX IF NOT EXISTS music_requests_event_spotify_unique
  ON music_requests(event_id, spotify_track_id)
  WHERE spotify_track_id IS NOT NULL;

ALTER TABLE events ADD COLUMN IF NOT EXISTS enable_dj_playlist boolean DEFAULT false NOT NULL;
