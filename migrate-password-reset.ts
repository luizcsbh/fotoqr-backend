import dotenv from 'dotenv';
dotenv.config();

import { db } from './src/config/database.js';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('Running migration: 0010_add_password_reset_tokens...');
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(255) NOT NULL UNIQUE,
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      used_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pwd_reset_token_hash_idx ON password_reset_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS pwd_reset_user_id_idx ON password_reset_tokens(user_id);
  `));
  console.log('Migration completed successfully!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
