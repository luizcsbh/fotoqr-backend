import { Request } from 'express';
import { db } from '../config/database.js';
import { auditLogs, eventAuditLogs, events, users, EventAuditLog } from '../models/schema.js';
import { and, eq, desc, gte, lte, sql, SQL } from 'drizzle-orm';
import { logger } from '../utils/logger.js';

/** Who performed an action (null for anonymous guests; id 0 when only the e-mail is known). */
export interface AuditActor {
  id: number;
  email?: string | null;
  name?: string | null;
}

export interface AuditEntry {
  actor?: AuditActor | null;
  action: string;
  entityType: string;
  entityId?: number | null;
  eventId?: number | null;
  eventTitle?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

/** Actor and IP of the request, ready to spread into an AuditEntry. */
export function auditContext(req: Request): Pick<AuditEntry, 'actor' | 'ipAddress'> {
  return {
    actor: req.user ? { id: req.user.id, email: req.user.email, name: req.user.name } : null,
    ipAddress: req.ip ? req.ip.slice(0, 45) : null,
  };
}

/**
 * Writes one entry of the platform audit trail. Never throws: an audit failure must not undo or
 * block the action being audited.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      // id 0 = known e-mail but no account in hand (failed login, reset link): snapshot only
      userId: entry.actor?.id || null,
      actorEmail: entry.actor?.email?.slice(0, 255) ?? null,
      actorName: entry.actor?.name?.slice(0, 255) ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      eventId: entry.eventId ?? null,
      eventTitle: entry.eventTitle?.slice(0, 255) ?? null,
      description: entry.description ?? null,
      metadata: entry.metadata ? JSON.parse(JSON.stringify(entry.metadata)) : null,
      ipAddress: entry.ipAddress ?? null,
    });
  } catch (error) {
    logger.error(`Falha ao gravar log de auditoria (${entry.action}):`, error);
  }
}

export async function logAuditEvent(
  eventId: number,
  userId: number | null,
  action: string,
  entityType: string,
  entityId?: number,
  metadata?: any,
  ipAddress?: string
): Promise<EventAuditLog> {
  // Mirrored into the platform trail, which keeps it after the event is deleted
  await recordAudit({
    actor: userId ? { id: userId } : null,
    action,
    entityType,
    entityId: entityId ?? null,
    eventId,
    metadata: metadata ?? null,
    ipAddress: ipAddress ?? null,
  });

  try {
    const [log] = await db
      .insert(eventAuditLogs)
      .values({
        eventId,
        userId: userId ?? null,
        action,
        entityType,
        entityId: entityId ?? null,
        metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : null,
        ipAddress: ipAddress || null,
      })
      .returning();

    return log;
  } catch (error) {
    logger.error('Falha ao gravar log de auditoria:', error);
    // Do not crash primary operations on audit failure
    return {
      id: 0,
      eventId,
      userId: userId ?? null,
      action,
      entityType,
      entityId: entityId ?? null,
      metadata: null,
      ipAddress: ipAddress || null,
      createdAt: new Date(),
    };
  }
}

export async function getEventAuditLogs(eventId: number, limit = 100): Promise<EventAuditLog[]> {
  return db
    .select()
    .from(eventAuditLogs)
    .where(eq(eventAuditLogs.eventId, eventId))
    .orderBy(desc(eventAuditLogs.createdAt))
    .limit(limit);
}

export interface AuditLogFilters {
  page?: number;
  limit?: number;
  action?: string;
  /** Matches the actor's name/e-mail, the event title or the description */
  search?: string;
  from?: Date;
  to?: Date;
}

export interface AuditLogItem {
  id: number;
  action: string;
  entityType: string;
  entityId: number | null;
  eventId: number | null;
  eventTitle: string | null;
  description: string | null;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: Date;
  actor: { id: number | null; name: string | null; email: string | null } | null;
}

/** Paginated platform audit trail, newest first (super admin screen). */
export async function listAuditLogs(filters: AuditLogFilters = {}): Promise<{
  items: AuditLogItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  actions: string[];
}> {
  const page = Math.max(1, Math.floor(filters.page || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(filters.limit || 30)));

  // Current names win; the snapshot covers deleted users and events
  const actorName = sql<string | null>`coalesce(${users.name}, ${auditLogs.actorName})`;
  const actorEmail = sql<string | null>`coalesce(${users.email}, ${auditLogs.actorEmail})`;
  const eventTitle = sql<string | null>`coalesce(${auditLogs.eventTitle}, ${events.title})`;

  const conditions: SQL[] = [];
  if (filters.action) conditions.push(eq(auditLogs.action, filters.action));
  if (filters.from) conditions.push(gte(auditLogs.createdAt, filters.from));
  if (filters.to) conditions.push(lte(auditLogs.createdAt, filters.to));
  const search = filters.search?.trim();
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(
      sql`(${actorName} ILIKE ${pattern} OR ${actorEmail} ILIKE ${pattern} OR ${eventTitle} ILIKE ${pattern} OR ${auditLogs.description} ILIKE ${pattern})`
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      log: auditLogs,
      actorName,
      actorEmail,
      eventTitle,
    })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .leftJoin(events, eq(auditLogs.eventId, events.id))
    .where(where)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(limit)
    .offset((page - 1) * limit);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(auditLogs)
    .leftJoin(users, eq(auditLogs.userId, users.id))
    .leftJoin(events, eq(auditLogs.eventId, events.id))
    .where(where);

  const actionRows = await db
    .selectDistinct({ action: auditLogs.action })
    .from(auditLogs)
    .orderBy(auditLogs.action);

  return {
    items: rows.map(({ log, actorName: name, actorEmail: email, eventTitle: title }) => ({
      id: log.id,
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      eventId: log.eventId,
      eventTitle: title,
      description: log.description,
      metadata: log.metadata,
      ipAddress: log.ipAddress,
      createdAt: log.createdAt,
      actor: log.userId || name || email ? { id: log.userId, name, email } : null,
    })),
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    actions: actionRows.map((r) => r.action),
  };
}
