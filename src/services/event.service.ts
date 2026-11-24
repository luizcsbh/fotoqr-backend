import { v4 as uuidv4 } from 'uuid';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { events, photos, Event, NewEvent, Photo, users } from '../models/schema.js';
import { validateEventInput } from '../utils/validators.js';
import { generateQRCode } from '../utils/qrcode.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { localStorageService } from './local.storage.service.js';
import { QRCustomization, sanitizeQRCustomization } from '../utils/qrCustomization.js';
import { isSuperOrPlatformAdmin } from '../middleware/rbac.js';

export interface CreateEventDTO {
  title: string;
  description?: string;
  eventDate?: string | Date;
  startDate?: string | Date;
  start_date?: string | Date;
  endDate?: string | Date;
  end_date?: string | Date;
  storageMode?: 'fallback';
  enableDjPlaylist?: boolean;
  enable_dj_playlist?: boolean;
  requirePhotoApproval?: boolean;
  require_photo_approval?: boolean;
}

export interface EventWithQR extends Event {
  qrCodeUrl: string;
  publicUrl: string;
  ownerName?: string | null;
  ownerEmail?: string | null;
  owner_name?: string | null;
  owner_email?: string | null;
}

export interface EventStats {
  eventId: number;
  title: string;
  uuid: string;
  isActive: boolean;
  totalPhotos: number;
  /** Photos waiting for host approval (not counted in totalPhotos) */
  pendingPhotos: number;
  totalStorageBytes: number;
  storageMode: string;
  providersBreakdown: Record<string, number>;
  latestUpload: Date | null;
}

export class EventService {
  /**
   * Creates a new photo album event.
   */
  async createEvent(userId: number, data: CreateEventDTO): Promise<EventWithQR> {
    const validation = validateEventInput(data);
    if (!validation.valid) {
      throw new Error(validation.errors.join(' '));
    }

    const uuid = uuidv4();
    const storageMode = 'fallback';

    const rawStart = data.startDate || data.start_date || data.eventDate;
    const rawEnd = data.endDate || data.end_date;
    const startDate = rawStart ? new Date(rawStart) : null;
    const endDate = rawEnd ? new Date(rawEnd) : null;
    const eventDate = startDate || (data.eventDate ? new Date(data.eventDate) : null);

    const [newEvent] = await db
      .insert(events)
      .values({
        uuid,
        userId,
        title: data.title.trim(),
        description: data.description ? data.description.trim() : null,
        eventDate,
        startDate,
        endDate,
        storageMode,
        isActive: true,
        enableDjPlaylist: Boolean(data.enableDjPlaylist ?? data.enable_dj_playlist ?? false),
        requirePhotoApproval: Boolean(data.requirePhotoApproval ?? data.require_photo_approval ?? false),
        photoCount: 0,
      })
      .returning();

    const publicUrl = `${env.FRONTEND_URL}/e/${uuid}`;
    const qrCodeUrl = await generateQRCode(publicUrl);

    logger.info(`Novo evento criado: "${newEvent.title}" (UUID: ${uuid}) pelo usuário ID ${userId}`);

    return {
      ...newEvent,
      publicUrl,
      qrCodeUrl,
    };
  }

  /**
   * Updates an existing event, strictly preserving its immutable UUID and public QR Code.
   */
  async updateEvent(
    identifier: string | number,
    userId: number,
    data: any,
    role?: string,
    email?: string
  ): Promise<EventWithQR> {
    const isSuper = isSuperOrPlatformAdmin(role, email);
    const trimmed = String(identifier).trim();

    const isNumeric = /^\d+$/.test(trimmed);
    const existing = await db
      .select()
      .from(events)
      .where(isNumeric ? eq(events.id, Number(trimmed)) : eq(events.uuid, trimmed))
      .limit(1);

    const event = existing[0];
    if (!event) {
      throw new Error('Evento não encontrado.');
    }

    if (event.userId !== userId && !isSuper) {
      throw new Error('Você não possui permissão para editar este evento.');
    }

    if (data.title !== undefined) {
      if (typeof data.title !== 'string' || data.title.trim().length === 0) {
        throw new Error('O título do evento é obrigatório.');
      }
      if (data.title.trim().length < 2) {
        throw new Error('O título do evento deve ter pelo menos 2 caracteres.');
      }
    }

    const updatePayload: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (data.title !== undefined) {
      updatePayload.title = String(data.title).trim();
    }
    if (data.description !== undefined) {
      updatePayload.description = data.description ? String(data.description).trim() : null;
    }
    if (data.category !== undefined) {
      updatePayload.category = data.category ? String(data.category).trim() : null;
    }
    if (data.location !== undefined) {
      updatePayload.location = data.location ? String(data.location).trim() : null;
    }
    if (data.capacity !== undefined) {
      updatePayload.capacity = data.capacity ? Number(data.capacity) : null;
    }
    if (data.status !== undefined) {
      updatePayload.status = String(data.status);
    }
    if (data.maxEntriesPerInvitation !== undefined || data.max_entries_per_invitation !== undefined) {
      updatePayload.maxEntriesPerInvitation = Number(data.maxEntriesPerInvitation ?? data.max_entries_per_invitation) || 1;
    }

    const rawStart = data.startAt ?? data.start_at ?? data.startDate ?? data.start_date ?? data.eventDate ?? data.event_date;
    if (rawStart !== undefined) {
      const parsed = rawStart ? new Date(rawStart) : null;
      updatePayload.startAt = parsed;
      updatePayload.startDate = parsed;
      updatePayload.eventDate = parsed;
    }

    const rawEnd = data.endAt ?? data.end_at ?? data.endDate ?? data.end_date;
    if (rawEnd !== undefined) {
      const parsed = rawEnd ? new Date(rawEnd) : null;
      updatePayload.endAt = parsed;
      updatePayload.endDate = parsed;
    }

    if (data.isActive !== undefined || data.is_active !== undefined) {
      updatePayload.isActive = Boolean(data.isActive ?? data.is_active);
    }
    if (data.enableDjPlaylist !== undefined || data.enable_dj_playlist !== undefined) {
      updatePayload.enableDjPlaylist = Boolean(data.enableDjPlaylist ?? data.enable_dj_playlist);
    }
    if (data.requirePhotoApproval !== undefined || data.require_photo_approval !== undefined) {
      updatePayload.requirePhotoApproval = Boolean(data.requirePhotoApproval ?? data.require_photo_approval);
    }
    if (data.enableMessageWall !== undefined || data.enable_message_wall !== undefined) {
      updatePayload.enableMessageWall = Boolean(data.enableMessageWall ?? data.enable_message_wall);
    }
    if (data.invitationTemplate !== undefined || data.invitation_template !== undefined) {
      updatePayload.invitationTemplate = data.invitationTemplate ?? data.invitation_template ?? null;
    }

    // Notice: uuid is explicitly NOT updated, guaranteeing the same QR Code, URL, and tokens stay unchanged
    const [updatedEvent] = await db
      .update(events)
      .set(updatePayload)
      .where(eq(events.id, event.id))
      .returning();

    logger.info(`Evento ID ${event.id} atualizado com sucesso. UUID e QR Code mantidos intactos (${event.uuid})`);
    return this.withQRCode(updatedEvent);
  }

  /**
   * Retrieves an event by its public UUID or numeric ID.
   * Numeric IDs are sequential and guessable, so they only resolve for the event owner or super admin;
   * anonymous access must use the public UUID.
   */
  async getEventByIdOrUuid(identifier: string | number, userId?: number, role?: string, email?: string): Promise<EventWithQR | null> {
    const trimmed = String(identifier).trim();

    if (!/^\d+$/.test(trimmed)) {
      return this.getEventByUuid(trimmed);
    }

    const isSuper = isSuperOrPlatformAdmin(role, email);
    const whereCondition = (userId && !isSuper)
      ? and(eq(events.id, Number(trimmed)), eq(events.userId, userId))
      : eq(events.id, Number(trimmed));

    const [event] = await db
      .select()
      .from(events)
      .where(whereCondition)
      .limit(1);

    return event ? this.withQRCode(event) : null;
  }

  /**
   * Retrieves an event by its public UUID.
   */
  async getEventByUuid(uuid: string): Promise<EventWithQR | null> {
    const [event] = await db.select().from(events).where(eq(events.uuid, uuid.trim())).limit(1);
    return event ? this.withQRCode(event) : null;
  }

  private async withQRCode(event: Event): Promise<EventWithQR> {
    const publicUrl = `${env.FRONTEND_URL}/e/${event.uuid}`;
    const qrCodeUrl = await generateQRCode(publicUrl);

    return {
      ...event,
      publicUrl,
      qrCodeUrl,
    };
  }

  /**
   * Lists all events owned by a specific authenticated user (or all platform events if super admin).
   */
  async getUserEvents(userId: number, role?: string, email?: string): Promise<EventWithQR[]> {
    const isSuper = isSuperOrPlatformAdmin(role, email);
    const userEvents = await (isSuper
      ? db
          .select({
            event: events,
            ownerName: users.name,
            ownerEmail: users.email,
          })
          .from(events)
          .leftJoin(users, eq(events.userId, users.id))
          .orderBy(desc(events.createdAt))
      : db
          .select({
            event: events,
            ownerName: sql<string | null>`NULL`,
            ownerEmail: sql<string | null>`NULL`,
          })
          .from(events)
          .where(eq(events.userId, userId))
          .orderBy(desc(events.createdAt)));

    const eventsWithQR = await Promise.all(
      userEvents.map(async (row) => {
        const ev = row.event;
        const publicUrl = `${env.FRONTEND_URL}/e/${ev.uuid}`;
        const qrCodeUrl = await generateQRCode(publicUrl);
        return {
          ...ev,
          publicUrl,
          qrCodeUrl,
          ownerName: row.ownerName || null,
          ownerEmail: row.ownerEmail || null,
          owner_name: row.ownerName || null,
          owner_email: row.ownerEmail || null,
        };
      })
    );

    return eventsWithQR;
  }

  /**
   * Toggles the active status of an event (enabling or pausing photo uploads).
   */
  async toggleEventActive(eventId: number, userId: number, role?: string, email?: string): Promise<Event> {
    const isSuper = isSuperOrPlatformAdmin(role, email);
    const [event] = await db
      .select()
      .from(events)
      .where(isSuper ? eq(events.id, eventId) : and(eq(events.id, eventId), eq(events.userId, userId)))
      .limit(1);

    if (!event) {
      throw new Error('Evento não encontrado ou acesso não autorizado.');
    }

    const [updatedEvent] = await db
      .update(events)
      .set({
        isActive: !event.isActive,
        updatedAt: new Date(),
      })
      .where(eq(events.id, eventId))
      .returning();

    logger.info(`Status do evento ${eventId} alterado para isActive=${updatedEvent.isActive}`);
    return updatedEvent;
  }

  /**
   * Turns the guests' DJ song request playlist on or off (toggles when `enabled` is omitted).
   */
  async setDjPlaylistEnabled(eventId: number, userId: number, enabled?: boolean, role?: string, email?: string): Promise<Event> {
    const isSuper = isSuperOrPlatformAdmin(role, email);
    const [event] = await db
      .select()
      .from(events)
      .where(isSuper ? eq(events.id, eventId) : and(eq(events.id, eventId), eq(events.userId, userId)))
      .limit(1);

    if (!event) {
      throw new Error('Evento não encontrado ou acesso não autorizado.');
    }

    const [updatedEvent] = await db
      .update(events)
      .set({
        enableDjPlaylist: enabled ?? !event.enableDjPlaylist,
        updatedAt: new Date(),
      })
      .where(eq(events.id, eventId))
      .returning();

    logger.info(`Playlist do DJ do evento ${eventId} alterada para enableDjPlaylist=${updatedEvent.enableDjPlaylist}`);
    return updatedEvent;
  }

  /**
   * Turns host review of guest photos on or off (toggles when `enabled` is omitted).
   * Photos already waiting stay pending until the owner approves or deletes them.
   */
  async setPhotoApprovalRequired(eventId: number, userId: number, enabled?: boolean, role?: string, email?: string): Promise<Event> {
    const isSuper = isSuperOrPlatformAdmin(role, email);
    const [event] = await db
      .select()
      .from(events)
      .where(isSuper ? eq(events.id, eventId) : and(eq(events.id, eventId), eq(events.userId, userId)))
      .limit(1);

    if (!event) {
      throw new Error('Evento não encontrado ou acesso não autorizado.');
    }

    const [updatedEvent] = await db
      .update(events)
      .set({
        requirePhotoApproval: enabled ?? !event.requirePhotoApproval,
        updatedAt: new Date(),
      })
      .where(eq(events.id, eventId))
      .returning();

    logger.info(`Aprovação de fotos do evento ${eventId} alterada para requirePhotoApproval=${updatedEvent.requirePhotoApproval}`);
    return updatedEvent;
  }

  /**
   * Saves the owner's QR code / table card design for the event (validated, known fields only).
   */
  async saveQRCustomization(eventId: number, userId: number, input: unknown, role?: string, email?: string): Promise<QRCustomization> {
    const qrCustomization = sanitizeQRCustomization(input);
    const isSuper = isSuperOrPlatformAdmin(role, email);

    const [updatedEvent] = await db
      .update(events)
      .set({ qrCustomization, updatedAt: new Date() })
      .where(isSuper ? eq(events.id, eventId) : and(eq(events.id, eventId), eq(events.userId, userId)))
      .returning({ qrCustomization: events.qrCustomization });

    if (!updatedEvent) {
      throw new Error('Evento não encontrado ou acesso não autorizado.');
    }
    return updatedEvent.qrCustomization!;
  }

  /**
   * Deletes an event and its associated photos.
   */
  /**
   * Deletes an event together with every photo uploaded to it (database rows and stored files).
   */
  async deleteEvent(
    eventId: number,
    userId: number,
    role?: string,
    email?: string
  ): Promise<{ event: Event; photosDeleted: number }> {
    const isSuper = isSuperOrPlatformAdmin(role, email);
    const [event] = await db
      .select()
      .from(events)
      .where(isSuper ? eq(events.id, eventId) : and(eq(events.id, eventId), eq(events.userId, userId)))
      .limit(1);

    if (!event) {
      throw new Error('Evento não encontrado ou acesso não autorizado.');
    }

    // Photos are removed explicitly (not only through ON DELETE CASCADE), in the same transaction as
    // the event, so an event is never deleted while its photos stay behind
    const deletedPhotos = await db.transaction(async (tx) => {
      const removed = await tx
        .delete(photos)
        .where(eq(photos.eventId, eventId))
        .returning({ storageProvider: photos.storageProvider, storagePath: photos.storagePath });
      await tx.delete(events).where(eq(events.id, eventId));
      return removed;
    });

    // Files kept outside the database (local disk) go after the commit; a leftover file is harmless,
    // a photo row without its event is not
    for (const photo of deletedPhotos) {
      if (photo.storageProvider === 'local' || photo.storageProvider === 'supabase') {
        await localStorageService.deletePhoto(photo.storagePath);
      }
    }
    await localStorageService.deleteEventFolder(eventId);

    logger.info(
      `Evento ${eventId} excluído pelo usuário ID ${userId} (role: ${role || 'user'}) com ${deletedPhotos.length} foto(s)`
    );
    return { event, photosDeleted: deletedPhotos.length };
  }

  /**
   * Computes statistics for a given event.
   */
  async getEventStats(eventId: number, userId: number, role?: string, email?: string): Promise<EventStats> {
    const isSuper = isSuperOrPlatformAdmin(role, email);
    const [event] = await db
      .select()
      .from(events)
      .where(isSuper ? eq(events.id, eventId) : and(eq(events.id, eventId), eq(events.userId, userId)))
      .limit(1);

    if (!event) {
      throw new Error('Evento não encontrado ou acesso não autorizado.');
    }

    // Aggregate storage bytes and counts
    const [aggregate] = await db
      .select({
        totalPhotos: sql<number>`count(*)::int`,
        totalBytes: sql<number>`coalesce(sum(${photos.fileSize}), 0)::bigint`,
        latestUpload: sql<Date | null>`max(${photos.uploadedAt})`,
      })
      .from(photos)
      .where(
        and(eq(photos.eventId, eventId), eq(photos.uploadStatus, 'success'), eq(photos.reviewStatus, 'approved'))
      );

    const [pending] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(photos)
      .where(
        and(eq(photos.eventId, eventId), eq(photos.uploadStatus, 'success'), eq(photos.reviewStatus, 'pending'))
      );

    // Breakdown by storage provider
    const breakdownRows = await db
      .select({
        provider: photos.storageProvider,
        count: sql<number>`count(*)::int`,
      })
      .from(photos)
      .where(
        and(eq(photos.eventId, eventId), eq(photos.uploadStatus, 'success'), eq(photos.reviewStatus, 'approved'))
      )
      .groupBy(photos.storageProvider);

    const providersBreakdown: Record<string, number> = {};
    for (const row of breakdownRows) {
      providersBreakdown[row.provider] = row.count;
    }

    return {
      eventId: event.id,
      title: event.title,
      uuid: event.uuid,
      isActive: event.isActive,
      totalPhotos: aggregate?.totalPhotos || 0,
      pendingPhotos: pending?.count || 0,
      totalStorageBytes: Number(aggregate?.totalBytes || 0),
      storageMode: event.storageMode,
      providersBreakdown,
      latestUpload: aggregate?.latestUpload || null,
    };
  }
}

export const eventService = new EventService();
export default eventService;
