import { sql } from 'drizzle-orm';
import { db } from './database.js';
import { logger } from '../utils/logger.js';

/**
 * Idempotent schema changes applied at startup, so a deploy never runs code that reads a column the
 * database does not have yet (migrations in this project are run by hand).
 */
export async function ensureSchema(): Promise<void> {
  try {
    await db.execute(sql.raw('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0'));
  } catch (err) {
    logger.error('Falha ao aplicar ajustes de schema na inicialização (token_version):', err);
  }

  try {
    await db.execute(sql.raw(`
      CREATE TABLE IF NOT EXISTS event_djs (
        id SERIAL PRIMARY KEY,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS event_djs_event_id_idx ON event_djs(event_id);
      CREATE INDEX IF NOT EXISTS event_djs_user_id_idx ON event_djs(user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS event_djs_event_user_idx ON event_djs(event_id, user_id);
    `));
  } catch (err) {
    logger.error('Falha ao aplicar ajustes de schema na inicialização (event_djs):', err);
  }
}
