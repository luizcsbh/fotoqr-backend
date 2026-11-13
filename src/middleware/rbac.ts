import { Request, Response, NextFunction } from 'express';
import { db } from '../config/database.js';
import { events, eventUsers, eventReaders } from '../models/schema.js';
import { eq, and } from 'drizzle-orm';

export interface EventAccessContext {
  eventId: number;
  isOwner: boolean;
  isAdmin: boolean;
  isReader: boolean;
}

// Extend Request to include event access context
declare global {
  namespace Express {
    interface Request {
      eventAccess?: EventAccessContext;
    }
  }
}

export const rbacService = {
  /**
   * Resolves numeric event ID from string parameter (numeric ID or UUID).
   */
  async resolveEventId(idOrUuid: string): Promise<number | null> {
    if (!idOrUuid) return null;

    if (/^\d+$/.test(idOrUuid)) {
      const numericId = parseInt(idOrUuid, 10);
      const [event] = await db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.id, numericId))
        .limit(1);
      return event ? event.id : null;
    }

    // Look up by UUID
    const [event] = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.uuid, idOrUuid))
      .limit(1);

    return event ? event.id : null;
  },

  /**
   * Inspects all event roles for a given user and event.
   */
  async getEventAccess(userId: number, eventId: number): Promise<EventAccessContext> {
    const [event] = await db
      .select({ id: events.id, userId: events.userId })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    if (!event) {
      return {
        eventId,
        isOwner: false,
        isAdmin: false,
        isReader: false,
      };
    }

    const isOwner = event.userId === userId;

    // Check co-admin / staff in event_users
    const [collab] = await db
      .select({ role: eventUsers.role })
      .from(eventUsers)
      .where(and(eq(eventUsers.eventId, eventId), eq(eventUsers.userId, userId)))
      .limit(1);

    const isAdmin = isOwner || (collab ? collab.role === 'admin' : false);

    // Check reader in event_readers
    const [reader] = await db
      .select({ active: eventReaders.active })
      .from(eventReaders)
      .where(and(eq(eventReaders.eventId, eventId), eq(eventReaders.userId, userId)))
      .limit(1);

    const isReader = isAdmin || (reader ? reader.active : false);

    return {
      eventId,
      isOwner,
      isAdmin,
      isReader,
    };
  },
};

export const { resolveEventId, getEventAccess } = rbacService;

/**
 * True when the user may manage the event (owner, co-admin or platform admin).
 * Used by routes addressed by guest/invitation id instead of event id.
 */
export async function canAdminEvent(user: { id: number; role?: string } | undefined, eventId: number): Promise<boolean> {
  if (!user) return false;
  if (user.role === 'platform_admin') return true;
  const access = await rbacService.getEventAccess(user.id, eventId);
  return access.isAdmin;
}

/**
 * Middleware: Requires platform administrator privileges.
 */
export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: 'Autenticação necessária.',
    });
    return;
  }

  if (req.user.role !== 'platform_admin') {
    res.status(403).json({
      success: false,
      error: 'Acesso negado. Requer privilégios de Administrador da Plataforma.',
    });
    return;
  }

  next();
}

/**
 * Middleware: Requires Event Admin (Owner, Co-admin, or Platform Admin).
 */
export async function requireEventAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Autenticação necessária.',
      });
      return;
    }

    const rawParam = (req.params.eventId || req.params.id) as string;
    if (!rawParam) {
      res.status(400).json({
        success: false,
        error: 'Identificador do evento não informado.',
      });
      return;
    }

    const eventId = await rbacService.resolveEventId(rawParam);
    if (!eventId) {
      res.status(404).json({
        success: false,
        error: 'Evento não encontrado.',
      });
      return;
    }

    if (req.user.role === 'platform_admin') {
      req.eventAccess = {
        eventId,
        isOwner: true,
        isAdmin: true,
        isReader: true,
      };
      return next();
    }

    const access = await rbacService.getEventAccess(req.user.id, eventId);
    if (!access.isAdmin) {
      res.status(403).json({
        success: false,
        error: 'Acesso negado. Você não possui permissão de administração para este evento.',
      });
      return;
    }

    req.eventAccess = access;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Middleware: Requires Event Reader (Reader, Event Admin, or Platform Admin).
 */
export async function requireEventReader(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Autenticação necessária.',
      });
      return;
    }

    const rawParam = (req.params.eventId || req.params.id || req.body?.eventId) as string;
    if (!rawParam) {
      res.status(400).json({
        success: false,
        error: 'Identificador do evento não informado.',
      });
      return;
    }

    const eventId = await rbacService.resolveEventId(String(rawParam));
    if (!eventId) {
      res.status(404).json({
        success: false,
        error: 'Evento não encontrado.',
      });
      return;
    }

    if (req.user.role === 'platform_admin') {
      req.eventAccess = {
        eventId,
        isOwner: true,
        isAdmin: true,
        isReader: true,
      };
      return next();
    }

    const access = await rbacService.getEventAccess(req.user.id, eventId);
    if (!access.isReader) {
      res.status(403).json({
        success: false,
        error: 'Acesso negado. Você não possui permissão de leitor de QR Code para este evento.',
      });
      return;
    }

    req.eventAccess = access;
    next();
  } catch (error) {
    next(error);
  }
}
