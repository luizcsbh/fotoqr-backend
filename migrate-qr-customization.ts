import fs from 'node:fs';
import path from 'node:path';
import { pool } from './src/config/database.js';

async function migrate() {
  console.log('Running QR customization migration...');

  try {
    // The file is idempotent (IF NOT EXISTS), so re-running is safe
    for (const name of ['0008_add_qr_customization.sql']) {
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
