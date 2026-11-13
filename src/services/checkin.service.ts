import crypto from 'node:crypto';
import { db } from '../config/database.js';
import {
  eventCheckins,
  eventInvitations,
  eventGuests,
  events,
  eventReaders,
  users,
} from '../models/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { logAuditEvent } from './audit.service.js';
import { getCheckinDeadline, CHECKIN_GRACE_HOURS } from '../utils/eventWindow.js';

export type ValidationStatus =
  | 'VALIDO'
  | 'JA_UTILIZADO'
  | 'CANCELADO'
  | 'EXPIRADO'
  | 'INVALIDO'
  | 'EVENTO_INCORRETO';

export interface ValidationResponse {
  status: ValidationStatus;
  allowed: boolean;
  color: 'verde' | 'vermelho' | 'laranja';
  message: string;
  guest?: {
    id: number;
    name: string;
    category: string;
  };
  event?: {
    id: number;
    title: string;
  };
  checkin?: {
    id: number;
    checkedInAt: Date;
    deviceIdentifier?: string | null;
  };
  entriesCount?: {
    used: number;
    max: number;
  };
}

export class CheckinService {
  /**
   * Hashes token if necessary.
   */
  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token.trim()).digest('hex');
  }

  /**
   * Validates a QR code token and registers check-in atomically inside a PostgreSQL transaction.
   * Uses row-level lock (FOR UPDATE) to prevent race conditions during simultaneous scans.
   */
  async validateAndCheckin(
    eventId: number,
    tokenOrRaw: string,
    readerUserId: number,
    deviceIdentifier?: string,
    ipAddress?: string
  ): Promise<ValidationResponse> {
    let cleanToken = String(tokenOrRaw).trim();
    if (!cleanToken) {
      return {
        status: 'INVALIDO',
        allowed: false,
        color: 'vermelho',
        message: 'QR Code não reconhecido.',
      };
    }

    // Se o leitor capturar a URL completa (ex: https://.../convite/<token_ou_hash>)
    if (cleanToken.includes('/convite/')) {
      const parts = cleanToken.split('/convite/');
      cleanToken = parts[parts.length - 1].split('?')[0].split('#')[0].trim();
    }

    // The QR code carries either the raw token or its stored hash (both 64 hex chars): match both
    const rawCandidate = cleanToken.toLowerCase();
    const hashedCandidate = this.hashToken(cleanToken);

    // Run within atomic transaction with row locking
    return await db.transaction(async (tx) => {
      // 1. Lock the invitation row for update
      const lockedRows = await tx.execute(
        sql`SELECT * FROM event_invitations WHERE token_hash IN (${rawCandidate}, ${hashedCandidate}) LIMIT 1 FOR UPDATE`
      );

      const invitation = (lockedRows.rows ? lockedRows.rows[0] : (lockedRows as any)[0]) as any;

      if (!invitation) {
        return {
          status: 'INVALIDO',
          allowed: false,
          color: 'vermelho',
          message: 'QR Code não reconhecido.',
        };
      }

      // 2. Fetch associated guest and event
      const [guest] = await tx
        .select()
        .from(eventGuests)
        .where(eq(eventGuests.id, invitation.guest_id || invitation.guestId))
        .limit(1);

      const [targetEvent] = await tx
        .select()
        .from(events)
        .where(eq(events.id, invitation.event_id || invitation.eventId))
        .limit(1);

      // Check if invitation belongs to this event
      if (Number(invitation.event_id || invitation.eventId) !== Number(eventId)) {
        await tx.insert(eventCheckins).values({
          eventId,
          invitationId: invitation.id,
          guestId: guest ? guest.id : invitation.guest_id || invitation.guestId,
          readerUserId,
          deviceIdentifier: deviceIdentifier || null,
          result: 'EVENTO_INCORRETO',
        });

        return {
          status: 'EVENTO_INCORRETO',
          allowed: false,
          color: 'vermelho',
          message: 'Este convite pertence a outro evento.',
          event: targetEvent ? { id: targetEvent.id, title: targetEvent.title } : undefined,
        };
      }

      // Check if cancelled
      if (invitation.status === 'cancelled') {
        await tx.insert(eventCheckins).values({
          eventId,
          invitationId: invitation.id,
          guestId: guest.id,
          readerUserId,
          deviceIdentifier: deviceIdentifier || null,
          result: 'CANCELADO',
        });

        return {
          status: 'CANCELADO',
          allowed: false,
          color: 'vermelho',
          message: 'Este convite foi cancelado.',
          guest: guest ? { id: guest.id, name: guest.name, category: guest.category } : undefined,
        };
      }

      // Check expiration against the event's CURRENT end (+ grace period for late arrivals).
      // invitation.valid_until is ignored: older invitations stored a copy of the event end taken
      // when they were issued, which went stale whenever the event dates changed.
      const now = new Date();
      const deadline = targetEvent ? getCheckinDeadline(targetEvent) : null;
      if (deadline && deadline < now) {
        await tx.insert(eventCheckins).values({
          eventId,
          invitationId: invitation.id,
          guestId: guest.id,
          readerUserId,
          deviceIdentifier: deviceIdentifier || null,
          result: 'EXPIRADO',
        });

        return {
          status: 'EXPIRADO',
          allowed: false,
          color: 'laranja',
          message: `O evento já terminou (convites valem até ${CHECKIN_GRACE_HOURS}h após o término).`,
          guest: guest ? { id: guest.id, name: guest.name, category: guest.category } : undefined,
        };
      }

      const usedEntries = Number(invitation.used_entries || invitation.usedEntries || 0);
      const maxEntries = Number(invitation.max_entries || invitation.maxEntries || 1);

      // Check if already used up
      if (usedEntries >= maxEntries) {
        await tx.insert(eventCheckins).values({
          eventId,
          invitationId: invitation.id,
          guestId: guest.id,
          readerUserId,
          deviceIdentifier: deviceIdentifier || null,
          result: 'JA_UTILIZADO',
        });

        return {
          status: 'JA_UTILIZADO',
          allowed: false,
          color: 'vermelho',
          message: 'Este convite já foi utilizado.',
          guest: guest ? { id: guest.id, name: guest.name, category: guest.category } : undefined,
          entriesCount: { used: usedEntries, max: maxEntries },
        };
      }

      // Success: Increment used entries atomically and register checkin
      const newUsedEntries = usedEntries + 1;
      const newStatus = newUsedEntries >= maxEntries ? 'used' : 'sent';

      await tx.execute(
        sql`UPDATE event_invitations SET used_entries = ${newUsedEntries}, status = ${newStatus}, updated_at = now() WHERE id = ${invitation.id}`
      );

      const [checkinRecord] = await tx
        .insert(eventCheckins)
        .values({
          eventId,
          invitationId: invitation.id,
          guestId: guest.id,
          readerUserId,
          deviceIdentifier: deviceIdentifier || null,
          result: 'VALIDO',
        })
        .returning();

      return {
        status: 'VALIDO',
        allowed: true,
        color: 'verde',
        message: 'Entrada autorizada!',
        guest: guest ? { id: guest.id, name: guest.name, category: guest.category } : undefined,
        event: targetEvent ? { id: targetEvent.id, title: targetEvent.title } : undefined,
        checkin: {
          id: checkinRecord.id,
          checkedInAt: checkinRecord.checkedInAt,
          deviceIdentifier: checkinRecord.deviceIdentifier,
        },
        entriesCount: { used: newUsedEntries, max: maxEntries },
      };
    });
  }

  /**
   * Adds an authorized QR reader user to an event.
   */
  async addReader(eventId: number, userEmailOrId: string | number, adminUserId: number, ipAddress?: string) {
    let targetUserId: number;

    if (typeof userEmailOrId === 'number' || /^\d+$/.test(String(userEmailOrId))) {
      targetUserId = Number(userEmailOrId);
      const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, targetUserId)).limit(1);
      if (!u) {
        throw new Error('Usuário leitor não encontrado na plataforma.');
      }
    } else {
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${String(userEmailOrId).trim().toLowerCase()}`)
        .limit(1);

      if (!u) {
        throw new Error('Usuário leitor não encontrado na plataforma com este e-mail.');
      }
      targetUserId = u.id;
    }

    const [existing] = await db
      .select()
      .from(eventReaders)
      .where(and(eq(eventReaders.eventId, eventId), eq(eventReaders.userId, targetUserId)))
      .limit(1);

    if (existing) {
      if (!existing.active) {
        const [updated] = await db
          .update(eventReaders)
          .set({ active: true })
          .where(eq(eventReaders.id, existing.id))
          .returning();
        return updated;
      }
      return existing;
    }

    const [reader] = await db
      .insert(eventReaders)
      .values({
        eventId,
        userId: targetUserId,
        active: true,
      })
      .returning();

    await logAuditEvent(eventId, adminUserId, 'READER_ADD', 'event_readers', reader.id, { targetUserId }, ipAddress);

    return reader;
  }

  /**
   * Removes / deactivates a reader from an event.
   */
  async removeReader(eventId: number, readerUserId: number, adminUserId: number, ipAddress?: string): Promise<void> {
    await db
      .delete(eventReaders)
      .where(and(eq(eventReaders.eventId, eventId), eq(eventReaders.userId, readerUserId)));

    await logAuditEvent(eventId, adminUserId, 'READER_REMOVE', 'event_readers', undefined, { readerUserId }, ipAddress);
  }

  /**
   * Lists all authorized readers for an event.
   */
  async listReaders(eventId: number) {
    return db
      .select({
        id: eventReaders.id,
        userId: users.id,
        name: users.name,
        email: users.email,
        active: eventReaders.active,
        createdAt: eventReaders.createdAt,
      })
      .from(eventReaders)
      .innerJoin(users, eq(eventReaders.userId, users.id))
      .where(eq(eventReaders.eventId, eventId));
  }
}

export const checkinService = new CheckinService();
export default checkinService;

