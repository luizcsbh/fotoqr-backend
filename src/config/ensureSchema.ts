import { sql, eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { db } from './database.js';
import { env } from './env.js';
import { users } from '../models/schema.js';
import { logger } from '../utils/logger.js';

/**
 * Idempotently ensures the Super Admin accounts configured in .env exist with super_admin role
 * and up-to-date credentials.
 */
export async function ensureSuperAdmin(): Promise<void> {
  const rawAdminEmails = env.SUPER_ADMIN_EMAIL || '';
  const adminPassword = env.SUPER_ADMIN_PASSWORD;

  const emails = rawAdminEmails
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);

  // Only SUPER_ADMIN_EMAIL accounts are super admins: any other account left with a super/platform
  // admin role (e.g. an e-mail removed from the list) goes back to a regular user, and its open
  // sessions end so the change takes effect right away
  try {
    const notConfigured = emails.length
      ? sql`lower(${users.email}) NOT IN (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})`
      : sql`true`;
    const demoted = await db
      .update(users)
      .set({ role: 'user', tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: new Date() })
      .where(sql`${users.role} IN ('super_admin', 'platform_admin') AND ${notConfigured}`)
      .returning({ id: users.id });
    if (demoted.length > 0) {
      logger.warn(
        `${demoted.length} conta(s) fora do SUPER_ADMIN_EMAIL deixaram de ser super admin (IDs: ${demoted.map((u) => u.id).join(', ')})`
      );
    }
  } catch (err) {
    logger.error('Falha ao rebaixar contas super admin fora do SUPER_ADMIN_EMAIL:', err);
  }

  if (emails.length === 0) {
    return;
  }

  for (const adminEmail of emails) {
    try {
      const [existing] = await db
        .select({ id: users.id, role: users.role, passwordHash: users.passwordHash })
        .from(users)
        .where(sql`lower(${users.email}) = ${adminEmail}`)
        .limit(1);

      if (!existing) {
        if (adminPassword) {
          const passwordHash = await bcrypt.hash(adminPassword, 12);
          await db.insert(users).values({
            email: adminEmail,
            name: adminEmail.split('@')[0] || 'Super Admin',
            passwordHash,
            role: 'super_admin',
          });
          logger.info(`Super Admin criado com sucesso: ${adminEmail}`);
        }
      } else {
        const passwordMatches = adminPassword && existing.passwordHash
          ? await bcrypt.compare(adminPassword, existing.passwordHash)
          : false;

        const updates: Record<string, any> = {};
        if (existing.role !== 'super_admin' && existing.role !== 'platform_admin') {
          updates.role = 'super_admin';
        }
        // Sync password for primary admin if provided and different
        if (adminPassword && !passwordMatches && adminEmail === emails[0]) {
          updates.passwordHash = await bcrypt.hash(adminPassword, 12);
          updates.tokenVersion = sql`${users.tokenVersion} + 1`;
        }

        if (Object.keys(updates).length > 0) {
          updates.updatedAt = new Date();
          await db.update(users).set(updates).where(eq(users.id, existing.id));
          logger.info(`Super Admin atualizado com sucesso (${adminEmail}, role=super_admin)`);
        }
      }
    } catch (err) {
      logger.error(`Falha ao provisionar Super Admin (${adminEmail}):`, err);
    }
  }
}

/**
 * Idempotent schema changes applied at startup, so a deploy never runs code that reads a column the
 * database does not have yet (migrations in this project are run by hand).
 */
export async function ensureSchema(): Promise<void> {
  try {
    // User management and platform audit trail. Runs before ensureSuperAdmin, which inserts users
    // (an insert names every column of the table, is_active included).
    await db.execute(sql.raw(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
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
    `));
  } catch (err) {
    logger.error('Falha ao aplicar ajustes de schema na inicialização (auditoria e gestão de usuários):', err);
  }

  await ensureSuperAdmin();
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

  try {
    // Exclusive access links for DJs and readers (see migration 0012)
    await db.execute(sql.raw(`
      ALTER TABLE event_djs ADD COLUMN IF NOT EXISTS access_nonce varchar(64);
      ALTER TABLE event_readers ADD COLUMN IF NOT EXISTS access_nonce varchar(64);
    `));
  } catch (err) {
    logger.error('Falha ao aplicar ajustes de schema na inicialização (access_nonce):', err);
  }

  try {
    // Ready-made invitation design (see migration 0013)
    await db.execute(sql.raw('ALTER TABLE events ADD COLUMN IF NOT EXISTS invitation_template varchar(50)'));
  } catch (err) {
    logger.error('Falha ao aplicar ajustes de schema na inicialização (invitation_template):', err);
  }

  try {
    // Guest message wall (see migration 0014)
    await db.execute(sql.raw(`
      ALTER TABLE events ADD COLUMN IF NOT EXISTS enable_message_wall boolean NOT NULL DEFAULT false;
      CREATE TABLE IF NOT EXISTS event_messages (
        id SERIAL PRIMARY KEY,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        guest_name varchar(80) NOT NULL,
        guest_phone varchar(20) NOT NULL,
        message text NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS event_messages_event_created_idx ON event_messages(event_id, created_at);
    `));
  } catch (err) {
    logger.error('Falha ao aplicar ajustes de schema na inicialização (mural de recados):', err);
  }
}
