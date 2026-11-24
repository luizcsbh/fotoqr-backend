-- User management (deactivate accounts) and the platform audit trail shown to super admins.
-- Also applied at startup by src/config/ensureSchema.ts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- No foreign key to events: the record of an event must survive the event's deletion
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_email varchar(255),
  actor_name varchar(255),
  action varchar(100) NOT NULL,
  entity_type varchar(100) NOT NULL,
  entity_id INTEGER,
  event_id INTEGER,
  event_title varchar(255),
  description text,
  metadata jsonb,
  ip_address varchar(45),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs(action);
CREATE INDEX IF NOT EXISTS audit_logs_user_id_idx ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS audit_logs_event_id_idx ON audit_logs(event_id);
