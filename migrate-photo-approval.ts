import fs from 'node:fs';
import path from 'node:path';
import { pool } from './src/config/database.js';

async function migrate() {
  console.log('Running photo approval migration...');

  try {
    // Both files are idempotent (IF NOT EXISTS), so re-running is safe
    for (const name of ['0006_add_photo_approval.sql', '0007_add_photo_review_reason.sql']) {
      const file = path.resolve('src/models/migrations', name);
      await pool.query(fs.readFileSync(file, 'utf8'));
      console.log(`✓ ${name} applied`);
    }
    console.log('\n✅ Migration complete!');
  } catch (err) {
    console.error('Migration error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();
