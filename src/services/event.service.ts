import { v4 as uuidv4 } from 'uuid';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { events, photos, Event, NewEvent, Photo } from '../models/schema.js';
import { validateEventInput } from '../utils/validators.js';
import { generateQRCode } from '../utils/qrcode.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { localStorageService } from './local.storage.service.js';

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
}

export interface EventWithQR extends Event {
  qrCodeUrl: string;
  publicUrl: string;
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
        enableDjPlaylist: data.enableDjPlaylist ?? false,
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
   * Retrieves an event by its public UUID or numeric ID.
   * Numeric IDs are sequential and guessable, so they only resolve for the event owner;
   * anonymous access must use the public UUID.
   */
  async getEventByIdOrUuid(identifier: string | number, userId?: number): Promise<EventWithQR | null> {
    const trimmed = String(identifier).trim();

    if (!/^\d+$/.test(trimmed)) {
      return this.getEventByUuid(trimmed);
    }

    if (!userId) {
      return null;
    }

    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, Number(trimmed)), eq(events.userId, userId)))
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
   * Lists all events owned by a specific authenticated user.
   */
  async getUserEvents(userId: number): Promise<EventWithQR[]> {
    const userEvents = await db
      .select()
      .from(events)
      .where(eq(events.userId, userId))
      .orderBy(desc(events.createdAt));

    const eventsWithQR = await Promise.all(
      userEvents.map(async (ev) => {
        const publicUrl = `${env.FRONTEND_URL}/e/${ev.uuid}`;
        const qrCodeUrl = await generateQRCode(publicUrl);
        return {
          ...ev,
          publicUrl,
          qrCodeUrl,
        };
      })
    );

    return eventsWithQR;
  }

  /**
   * Toggles the active status of an event (enabling or pausing photo uploads).
   */
  async toggleEventActive(eventId: number, userId: number): Promise<Event> {
    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.userId, userId)))
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
  async setDjPlaylistEnabled(eventId: number, userId: number, enabled?: boolean): Promise<Event> {
    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.userId, userId)))
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
  async setPhotoApprovalRequired(eventId: number, userId: number, enabled?: boolean): Promise<Event> {
    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.userId, userId)))
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
   * Deletes an event and its associated photos.
   */
  async deleteEvent(eventId: number, userId: number): Promise<void> {
    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.userId, userId)))
      .limit(1);

    if (!event) {
      throw new Error('Evento não encontrado ou acesso não autorizado.');
    }

    await db.delete(events).where(eq(events.id, eventId));
    await localStorageService.deleteEventFolder(eventId);
    logger.info(`Evento ${eventId} excluído com sucesso pelo usuário ID ${userId}`);
  }

  /**
   * Computes statistics for a given event.
   */
  async getEventStats(eventId: number, userId: number): Promise<EventStats> {
    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.userId, userId)))
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
