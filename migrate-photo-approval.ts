import fs from 'node:fs';
import path from 'node:path';
import { pool } from './src/config/database.js';

async function migrate() {
  console.log('Running photo approval migration...');

  try {
    const file = path.resolve('src/models/migrations/0006_add_photo_approval.sql');
    await pool.query(fs.readFileSync(file, 'utf8'));
    console.log('✓ photos.review_status and events.require_photo_approval ready');
    console.log('\n✅ Migration complete!');
  } catch (err) {
    console.error('Migration error:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();
