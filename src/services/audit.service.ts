import { db } from '../config/database.js';
import { eventAuditLogs, EventAuditLog, NewEventAuditLog } from '../models/schema.js';
import { eq, desc } from 'drizzle-orm';
import { logger } from '../utils/logger.js';

export async function logAuditEvent(
  eventId: number,
  userId: number | null,
  action: string,
  entityType: string,
  entityId?: number,
  metadata?: any,
  ipAddress?: string
): Promise<EventAuditLog> {
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

