import bcrypt from 'bcryptjs';
import { and, desc, eq, ne, sql, SQL } from 'drizzle-orm';
import { db } from '../config/database.js';
import { events, photos, users } from '../models/schema.js';
import { effectiveRole, isSuperAdminEmail } from '../middleware/rbac.js';
import { forgetTokenVersion } from '../middleware/auth.js';
import { localStorageService } from './local.storage.service.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { isUniqueViolation } from '../utils/dbErrors.js';
import { normalizeEmail, validateEmail, validateNewPasswordStrength } from './auth.service.js';

/**
 * Roles a super admin can assign from the user management screen. Super admin is not one of them:
 * only the e-mails in SUPER_ADMIN_EMAIL are super admins.
 */
export const ASSIGNABLE_ROLES = ['user', 'dj', 'reader'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export class UserAdminError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'UserAdminError';
  }
}

export interface ManagedUser {
  id: number;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  createdAt: Date;
  eventCount: number;
  photoCount: number;
  /** False for DJ/reader accounts created by an exclusive link: they have no password to log in */
  hasPassword: boolean;
  /** Listed in SUPER_ADMIN_EMAIL: always super admin, cannot be changed or removed here */
  isProtected: boolean;
}

export interface UserListFilters {
  page?: number;
  limit?: number;
  search?: string;
  role?: string;
  status?: 'active' | 'inactive';
}

export interface UserChanges {
  name?: string;
  email?: string;
  /** New password (never returned nor logged) */
  password?: string;
  role?: string;
  isActive?: boolean;
}

export interface NewUserData {
  name: string;
  email: string;
  password: string;
  role?: string;
}

/** Lower-cased e-mails listed in SUPER_ADMIN_EMAIL */
const superAdminEmails = (): string[] =>
  (env.SUPER_ADMIN_EMAIL || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

// Correlated subqueries are written with explicit aliases: in a single-table select Drizzle renders
// columns without their table ("id"), which Postgres rejects as ambiguous inside a subquery that
// also has an "id" column (events, photos)
export const eventCount = sql<number>`(select count(*)::int from events ev where ev.user_id = "users"."id")`;
export const photoCount = sql<number>`(select count(*)::int from photos ph join events ev on ev.id = ph.event_id where ev.user_id = "users"."id")`;
const hasPassword = sql<boolean>`("users"."password_hash" IS NOT NULL)`;

function toManagedUser(row: {
  id: number;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  createdAt: Date;
  eventCount: number;
  photoCount: number;
  hasPassword: boolean;
}): ManagedUser {
  return {
    ...row,
    hasPassword: Boolean(row.hasPassword),
    role: effectiveRole(row.role, row.email),
    eventCount: Number(row.eventCount) || 0,
    photoCount: Number(row.photoCount) || 0,
    isProtected: isSuperAdminEmail(row.email),
  };
}

async function findUser(userId: number) {
  const [user] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new UserAdminError('Usuário não encontrado.', 404);
  return user;
}

function validateName(name: unknown): string {
  const normalized = typeof name === 'string' ? name.trim() : '';
  if (normalized.length < 2 || normalized.length > 255) {
    throw new UserAdminError('Informe um nome entre 2 e 255 caracteres.', 400);
  }
  return normalized;
}

function validateRole(role: unknown): AssignableRole {
  if (!ASSIGNABLE_ROLES.includes(role as AssignableRole)) {
    throw new UserAdminError(`Perfil inválido. Use um destes: ${ASSIGNABLE_ROLES.join(', ')}.`, 400);
  }
  return role as AssignableRole;
}

/** One account per e-mail (any account, with or without a password). */
async function assertEmailAvailable(email: string, exceptUserId?: number): Promise<void> {
  const conditions = [sql`lower(${users.email}) = ${email}`];
  if (exceptUserId) conditions.push(ne(users.id, exceptUserId));
  const [existing] = await db.select({ id: users.id }).from(users).where(and(...conditions)).limit(1);
  if (existing) {
    throw new UserAdminError('Já existe uma conta com este e-mail. Procure-a na lista para editá-la.', 409);
  }
}

/** Nobody manages their own account here (checked before any database access). */
function assertNotSelf(actorId: number, userId: number): void {
  if (userId === actorId) {
    throw new UserAdminError('Você não pode alterar a sua própria conta por aqui. Use a página Meu perfil.', 400);
  }
}

/** Super admins listed in SUPER_ADMIN_EMAIL are managed by the server configuration only. */
function assertNotProtected(target: { email: string }): void {
  if (isSuperAdminEmail(target.email)) {
    throw new UserAdminError(
      'Esta conta é um super admin definido na configuração do servidor (SUPER_ADMIN_EMAIL) e não pode ser alterada aqui.',
      400
    );
  }
}

export const userAdminService = {
  async listUsers(filters: UserListFilters = {}) {
    const page = Math.max(1, Math.floor(filters.page || 1));
    const limit = Math.min(100, Math.max(1, Math.floor(filters.limit || 20)));

    const conditions: SQL[] = [];
    const search = filters.search?.trim();
    if (search) {
      const pattern = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(sql`(${users.name} ILIKE ${pattern} OR ${users.email} ILIKE ${pattern})`);
    }
    const admins = superAdminEmails();
    const isConfiguredAdmin = admins.length
      ? sql`lower(${users.email}) IN (${sql.join(admins.map((e) => sql`${e}`), sql`, `)})`
      : sql`false`;
    if (filters.role === 'super_admin') {
      conditions.push(isConfiguredAdmin);
    } else if (filters.role) {
      conditions.push(and(eq(users.role, filters.role), sql`NOT ${isConfiguredAdmin}`)!);
    }
    if (filters.status === 'active') conditions.push(eq(users.isActive, true));
    if (filters.status === 'inactive') conditions.push(eq(users.isActive, false));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        isActive: users.isActive,
        createdAt: users.createdAt,
        eventCount,
        photoCount,
        hasPassword,
      })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(limit)
      .offset((page - 1) * limit);

    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(users).where(where);

    return {
      items: rows.map(toManagedUser),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  },

  /**
   * Creates an account with a password (the person can log in right away).
   */
  async createUser(actorId: number, data: NewUserData): Promise<ManagedUser> {
    const name = validateName(data?.name);
    const email = typeof data?.email === 'string' ? normalizeEmail(data.email) : '';
    validateEmail(email);
    validateNewPasswordStrength(data?.password);
    const role = validateRole(data?.role ?? 'user');
    if (isSuperAdminEmail(email)) {
      throw new UserAdminError('Este e-mail é de um super admin definido na configuração do servidor.', 400);
    }
    await assertEmailAvailable(email);

    const passwordHash = await bcrypt.hash(data.password, 12);
    try {
      const [created] = await db
        .insert(users)
        .values({ name, email, passwordHash, role })
        .returning({ id: users.id });
      logger.info(`Usuário ${created.id} (${email}, ${role}) criado pelo super admin ${actorId}`);
      return this.getUser(created.id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new UserAdminError('Já existe uma conta com este e-mail.', 409);
      }
      throw error;
    }
  },

  /**
   * Changes a user's details, password, role and/or active status. Deactivating also ends every open session.
   * Returns the updated user and what actually changed (for the audit trail).
   */
  async updateUser(actorId: number, userId: number, changes: UserChanges) {
    assertNotSelf(actorId, userId);
    const target = await findUser(userId);
    assertNotProtected(target);

    const updates: { name?: string; email?: string; passwordHash?: string; role?: string; isActive?: boolean } = {};
    const changed: Record<string, { from: unknown; to: unknown }> = {};

    if (changes.name !== undefined) {
      const name = validateName(changes.name);
      if (name !== target.name) {
        updates.name = name;
        changed.name = { from: target.name, to: name };
      }
    }

    if (changes.email !== undefined) {
      const email = typeof changes.email === 'string' ? normalizeEmail(changes.email) : '';
      validateEmail(email);
      if (email !== target.email.toLowerCase()) {
        if (isSuperAdminEmail(email)) {
          throw new UserAdminError('Este e-mail é de um super admin definido na configuração do servidor.', 400);
        }
        await assertEmailAvailable(email, userId);
        updates.email = email;
        changed.email = { from: target.email, to: email };
      }
    }

    if (changes.password !== undefined && changes.password !== '') {
      validateNewPasswordStrength(changes.password);
      updates.passwordHash = await bcrypt.hash(changes.password, 12);
      // The value itself is never recorded
      changed.password = { from: null, to: null };
    }

    if (changes.role !== undefined) {
      const role = validateRole(changes.role);
      const current = effectiveRole(target.role, target.email);
      if (role !== current) {
        updates.role = role;
        changed.role = { from: current, to: role };
      }
    }

    if (changes.isActive !== undefined) {
      if (typeof changes.isActive !== 'boolean') {
        throw new UserAdminError('Status inválido.', 400);
      }
      if (changes.isActive !== target.isActive) {
        updates.isActive = changes.isActive;
        changed.isActive = { from: target.isActive, to: changes.isActive };
      }
    }

    if (Object.keys(changed).length === 0) {
      return { user: await this.getUser(userId), changed };
    }

    // A new password, e-mail, role or a deactivation takes effect on every open session right away
    const endsSessions = Boolean(changed.password || changed.email || changed.role || changed.isActive);
    try {
      await db
        .update(users)
        .set({
          ...updates,
          ...(endsSessions && { tokenVersion: sql`${users.tokenVersion} + 1` }),
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new UserAdminError('Já existe uma conta com este e-mail.', 409);
      }
      throw error;
    }
    if (endsSessions) forgetTokenVersion(userId);

    logger.info(`Usuário ${userId} alterado pelo super admin ${actorId}: ${Object.keys(changed).join(', ')}`);
    return { user: await this.getUser(userId), changed };
  },

  async getUser(userId: number): Promise<ManagedUser> {
    const [row] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        isActive: users.isActive,
        createdAt: users.createdAt,
        eventCount,
        photoCount,
        hasPassword,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) throw new UserAdminError('Usuário não encontrado.', 404);
    return toManagedUser(row);
  },

  /**
   * Permanently deletes a user together with their events and every photo of those events.
   */
  async deleteUser(actorId: number, userId: number) {
    assertNotSelf(actorId, userId);
    const target = await this.getUser(userId);
    assertNotProtected(target);

    const removed = await db.transaction(async (tx) => {
      const ownedEvents = await tx.select({ id: events.id }).from(events).where(eq(events.userId, userId));
      const eventIds = ownedEvents.map((e) => e.id);

      let deletedPhotos: Array<{ storageProvider: string; storagePath: string }> = [];
      if (eventIds.length > 0) {
        deletedPhotos = await tx
          .delete(photos)
          .where(sql`${photos.eventId} IN (${sql.join(eventIds.map((id) => sql`${id}`), sql`, `)})`)
          .returning({ storageProvider: photos.storageProvider, storagePath: photos.storagePath });
        await tx.delete(events).where(eq(events.userId, userId));
      }
      await tx.delete(users).where(eq(users.id, userId));
      return { eventIds, deletedPhotos };
    });
    forgetTokenVersion(userId);

    for (const photo of removed.deletedPhotos) {
      if (photo.storageProvider === 'local' || photo.storageProvider === 'supabase') {
        await localStorageService.deletePhoto(photo.storagePath);
      }
    }
    for (const eventId of removed.eventIds) {
      await localStorageService.deleteEventFolder(eventId);
    }

    logger.info(
      `Usuário ${userId} excluído pelo super admin ${actorId} (${removed.eventIds.length} evento(s), ${removed.deletedPhotos.length} foto(s))`
    );
    return {
      user: target,
      eventsDeleted: removed.eventIds.length,
      photosDeleted: removed.deletedPhotos.length,
    };
  },
};
