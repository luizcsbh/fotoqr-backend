import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './src/config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function migrate() {
  console.log('Running invitations & checkin migration (0009)...');

  try {
    const file = path.resolve(__dirname, 'src/models/migrations/0009_add_event_invitations_and_checkin.sql');
    const sql = fs.readFileSync(file, 'utf8');
    await pool.query(sql);
    console.log('✓ 0009_add_event_invitations_and_checkin.sql applied successfully');
    console.log('\n✅ Migration complete!');
  } catch (err) {
    console.error('Migration error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();

