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
}
