import { and, desc, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { eventMessages, events } from '../models/schema.js';
import { logger } from '../utils/logger.js';

export const MESSAGE_MAX_LENGTH = 500;
export const NAME_MAX_LENGTH = 80;

export class MessageWallError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'MessageWallError';
  }
}

export interface GuestMessageInput {
  name: string;
  phone: string;
  message: string;
}

// Control characters (except line breaks in the message) never reach the Telão
const CONTROL_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F]/g;

const cleanLine = (value: unknown) =>
  typeof value === 'string' ? value.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim() : '';

/**
 * Brazilian WhatsApp number as digits with country code (55 + DDD + number), or null.
 * Accepts masks such as "(31) 99999-8888" or "+55 31 99999-8888".
 */
export function normalizeWhatsApp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (!/^55[1-9][0-9]\d{8,9}$/.test(digits)) return null;
  return digits;
}

/** Checks the guest form: name, WhatsApp and message are all required. */
export function validateGuestMessage(input: unknown): GuestMessageInput {
  const body = (input ?? {}) as Record<string, unknown>;
  const name = cleanLine(body.name);
  const phone = normalizeWhatsApp(body.phone);
  const message =
    typeof body.message === 'string'
      ? body.message.replace(CONTROL_CHARS, '').replace(/\n{3,}/g, '\n\n').trim()
      : '';

  if (name.length < 2) throw new MessageWallError('Informe seu nome.', 400);
  if (name.length > NAME_MAX_LENGTH) throw new MessageWallError(`O nome pode ter até ${NAME_MAX_LENGTH} caracteres.`, 400);
  if (!phone) throw new MessageWallError('Informe um número de WhatsApp válido, com DDD.', 400);
  if (!message) throw new MessageWallError('Escreva sua mensagem.', 400);
  if (message.length > MESSAGE_MAX_LENGTH) {
    throw new MessageWallError(`A mensagem pode ter até ${MESSAGE_MAX_LENGTH} caracteres.`, 400);
  }
  return { name, phone, message };
}

export const messageWallService = {
  /** Saves a guest message on an event whose wall is on. */
  async createMessage(eventUuid: string, input: unknown) {
    const data = validateGuestMessage(input);

    const [event] = await db
      .select({ id: events.id, isActive: events.isActive, enableMessageWall: events.enableMessageWall })
      .from(events)
      .where(eq(events.uuid, eventUuid))
      .limit(1);
    if (!event) throw new MessageWallError('Evento não encontrado.', 404);
    if (!event.enableMessageWall) {
      throw new MessageWallError('O mural de recados não está ativo neste evento.', 403);
    }
    if (!event.isActive) throw new MessageWallError('Este evento não está recebendo recados no momento.', 403);

    const [saved] = await db
      .insert(eventMessages)
      .values({ eventId: event.id, guestName: data.name, guestPhone: data.phone, message: data.message })
      .returning();

    logger.info(`Novo recado no mural do evento ${event.id}`);
    return { id: saved.id, name: saved.guestName, message: saved.message, createdAt: saved.createdAt };
  },

  /** Everything the owner sees, WhatsApp included (newest first). */
  async listForOwner(eventId: number) {
    const rows = await db
      .select()
      .from(eventMessages)
      .where(eq(eventMessages.eventId, eventId))
      .orderBy(desc(eventMessages.createdAt))
      .limit(1000);
    return rows.map((m) => ({
      id: m.id,
      name: m.guestName,
      phone: m.guestPhone,
      message: m.message,
      createdAt: m.createdAt,
    }));
  },

  /** What the Telão shows: name and message only (newest first). */
  async listPublic(eventId: number, limit = 50) {
    const rows = await db
      .select({
        id: eventMessages.id,
        name: eventMessages.guestName,
        message: eventMessages.message,
        createdAt: eventMessages.createdAt,
      })
      .from(eventMessages)
      .where(eq(eventMessages.eventId, eventId))
      .orderBy(desc(eventMessages.createdAt))
      .limit(limit);
    return rows.map((m) => ({ ...m, id: String(m.id) }));
  },

  async deleteMessage(eventId: number, messageId: number): Promise<boolean> {
    const deleted = await db
      .delete(eventMessages)
      .where(and(eq(eventMessages.id, messageId), eq(eventMessages.eventId, eventId)))
      .returning({ id: eventMessages.id });
    return deleted.length > 0;
  },

  /** Turns the wall on/off (toggles when `enabled` is omitted). Owner only. */
  async setEnabled(eventId: number, userId: number, enabled?: boolean) {
    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.userId, userId)))
      .limit(1);
    if (!event) throw new MessageWallError('Evento não encontrado ou acesso não autorizado.', 404);

    const [updated] = await db
      .update(events)
      .set({ enableMessageWall: enabled ?? !event.enableMessageWall, updatedAt: new Date() })
      .where(eq(events.id, eventId))
      .returning();
    logger.info(`Mural de recados do evento ${eventId} alterado para enableMessageWall=${updated.enableMessageWall}`);
    return updated;
  },
};
