import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from './env.js';
import * as schema from '../models/schema.js';

const { Pool } = pg;

// Configure connection pool with Neon.tech / Cloud / Local Postgres support
const isSslRequired =
  env.DATABASE_URL.includes('sslmode=require') ||
  env.DATABASE_URL.includes('neon.tech') ||
  env.NODE_ENV === 'production';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: isSslRequired ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Erro inesperado no cliente do pool PostgreSQL:', err);
});

// Setup Drizzle ORM instance with full schema relations
export const db = drizzle(pool, { schema });

/**
 * Verifies database connectivity. Used during health checks and server startup.
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      return true;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Falha ao conectar com o banco de dados:', error);
    return false;
  }
}

export default db;
