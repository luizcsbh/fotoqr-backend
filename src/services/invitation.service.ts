import crypto from 'node:crypto';
import { db } from '../config/database.js';
import {
  eventInvitations,
  events,
  eventGuests,
  EventInvitation,
  EventGuest,
  Event,
} from '../models/schema.js';
import { eq, and, ne, inArray } from 'drizzle-orm';
import { generateQRCode } from '../utils/qrcode.js';
import { env } from '../config/env.js';
import { logAuditEvent } from './audit.service.js';
import PDFDocument from 'pdfkit';

export interface IssuedInvitation {
  id: number;
  eventId: number;
  guestId: number;
  guestName: string;
  guestCategory: string;
  tokenHash: string;
  rawToken?: string;
  qrCodeUrl: string;
  inviteUrl: string;
  status: string;
  maxEntries: number;
  usedEntries: number;
  validFrom: Date | null;
  validUntil: Date | null;
  issuedAt: Date | null;
  revokedAt: Date | null;
}

/** Date from a Date or date string (request bodies send strings); null when missing/invalid. */
const toDate = (value: unknown): Date | null => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return isNaN(d.getTime()) ? null : d;
};

export class InvitationService {
  /**
   * Generates a cryptographically secure random token (64 hex chars).
   */
  generateSecureToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Hashes a token with SHA-256 for secure database storage.
   */
  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token.trim()).digest('hex');
  }

  /**
   * Values to match against `token_hash` for a token taken from an invitation link.
   * Links carry either the raw token (right after creation) or the stored hash (lists, e-mails,
   * PDFs). Both are 64 hex chars, so the length alone cannot tell them apart: try both.
   */
  tokenHashCandidates(tokenOrHash: string): string[] {
    const clean = String(tokenOrHash ?? '').trim();
    if (!clean) return [];
    return Array.from(new Set([clean.toLowerCase(), this.hashToken(clean)]));
  }

  /**
   * Resolves the invitation id for a public link token (raw token or hash).
   */
  async findInvitationIdByToken(tokenOrHash: string): Promise<number | null> {
    const candidates = this.tokenHashCandidates(tokenOrHash);
    if (candidates.length === 0) return null;
    const [row] = await db
      .select({ id: eventInvitations.id })
      .from(eventInvitations)
      .where(inArray(eventInvitations.tokenHash, candidates))
      .limit(1);
    return row ? row.id : null;
  }

  /**
   * Generates or retrieves an individual invitation for a guest.
   */
  async createInvitation(
    eventId: number,
    guestId: number,
    userId: number,
    options?: { maxEntries?: number; validFrom?: Date; validUntil?: Date },
    ipAddress?: string
  ): Promise<IssuedInvitation> {
    const [guest] = await db
      .select()
      .from(eventGuests)
      .where(and(eq(eventGuests.id, guestId), eq(eventGuests.eventId, eventId)))
      .limit(1);

    if (!guest) {
      throw new Error('Convidado não encontrado para este evento.');
    }

    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    if (!event) {
      throw new Error('Evento não encontrado.');
    }

    // Check if an active invitation already exists (cancelled ones from earlier reissues are ignored,
    // otherwise a guest with a cancelled invitation would get a new active one on every call)
    const [existing] = await db
      .select()
      .from(eventInvitations)
      .where(
        and(
          eq(eventInvitations.guestId, guestId),
          eq(eventInvitations.eventId, eventId),
          ne(eventInvitations.status, 'cancelled')
        )
      )
      .limit(1);

    if (existing) {
      const inviteUrl = `${env.FRONTEND_URL}/convite/${existing.tokenHash}`;
      const qrCodeUrl = await generateQRCode(inviteUrl);

      return {
        id: existing.id,
        eventId: existing.eventId,
        guestId: existing.guestId,
        guestName: guest.name,
        guestCategory: guest.category,
        tokenHash: existing.tokenHash,
        qrCodeUrl,
        inviteUrl,
        status: existing.status,
        maxEntries: existing.maxEntries,
        usedEntries: existing.usedEntries,
        validFrom: existing.validFrom,
        validUntil: existing.validUntil,
        issuedAt: existing.issuedAt,
        revokedAt: existing.revokedAt,
      };
    }

    const rawToken = this.generateSecureToken();
    const tokenHash = this.hashToken(rawToken);

    const requestedMax = Number(options?.maxEntries);
    const maxEntries =
      Number.isInteger(requestedMax) && requestedMax > 0 ? requestedMax : event.maxEntriesPerInvitation || 1;
    const now = new Date();

    const [newInvite] = await db
      .insert(eventInvitations)
      .values({
        eventId,
        guestId,
        tokenHash,
        status: 'pending',
        maxEntries,
        usedEntries: 0,
        validFrom: toDate(options?.validFrom) || event.startAt || event.startDate || null,
        validUntil: toDate(options?.validUntil) || event.endAt || event.endDate || null,
        issuedAt: now,
      })
      .returning();

    // The public verification link uses the raw token so only holders of the link can access it
    const inviteUrl = `${env.FRONTEND_URL}/convite/${rawToken}`;
    const qrCodeUrl = await generateQRCode(inviteUrl);

    await logAuditEvent(
      eventId,
      userId,
      'INVITATION_CREATE',
      'event_invitations',
      newInvite.id,
      { guestId, guestName: guest.name },
      ipAddress
    );

    return {
      id: newInvite.id,
      eventId: newInvite.eventId,
      guestId: newInvite.guestId,
      guestName: guest.name,
      guestCategory: guest.category,
      tokenHash: newInvite.tokenHash,
      rawToken,
      qrCodeUrl,
      inviteUrl,
      status: newInvite.status,
      maxEntries: newInvite.maxEntries,
      usedEntries: newInvite.usedEntries,
      validFrom: newInvite.validFrom,
      validUntil: newInvite.validUntil,
      issuedAt: newInvite.issuedAt,
      revokedAt: newInvite.revokedAt,
    };
  }

  /**
   * Generates invitations for all guests who do not have an active invitation yet.
   */
  async generateBulkInvitations(
    eventId: number,
    userId: number,
    ipAddress?: string
  ): Promise<{ generated: number; totalGuests: number }> {
    const allGuests = await db
      .select({ id: eventGuests.id })
      .from(eventGuests)
      .where(eq(eventGuests.eventId, eventId));

    let generated = 0;

    for (const g of allGuests) {
      const [existing] = await db
        .select({ id: eventInvitations.id })
        .from(eventInvitations)
        .where(and(eq(eventInvitations.guestId, g.id), eq(eventInvitations.eventId, eventId)))
        .limit(1);

      if (!existing) {
        await this.createInvitation(eventId, g.id, userId, undefined, ipAddress);
        generated++;
      }
    }

    return {
      generated,
      totalGuests: allGuests.length,
    };
  }

  /**
   * Cancels / Revokes an invitation immediately.
   */
  async revokeInvitation(invitationId: number, userId: number, ipAddress?: string): Promise<EventInvitation> {
    const [invitation] = await db
      .select()
      .from(eventInvitations)
      .where(eq(eventInvitations.id, invitationId))
      .limit(1);

    if (!invitation) {
      throw new Error('Convite não encontrado.');
    }

    const [updated] = await db
      .update(eventInvitations)
      .set({
        status: 'cancelled',
        revokedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(eventInvitations.id, invitationId))
      .returning();

    await logAuditEvent(
      invitation.eventId,
      userId,
      'INVITATION_REVOKE',
      'event_invitations',
      invitationId,
      undefined,
      ipAddress
    );

    return updated;
  }

  /**
   * Cancels previous invitation and reissues a brand new one with a fresh token.
   */
  async reissueInvitation(
    invitationId: number,
    userId: number,
    ipAddress?: string
  ): Promise<IssuedInvitation> {
    const [oldInvite] = await db
      .select()
      .from(eventInvitations)
      .where(eq(eventInvitations.id, invitationId))
      .limit(1);

    if (!oldInvite) {
      throw new Error('Convite original não encontrado.');
    }

    // Revoke old invitation
    await this.revokeInvitation(invitationId, userId, ipAddress);

    // Create new invitation for the same guest
    const newInvite = await this.createInvitation(
      oldInvite.eventId,
      oldInvite.guestId,
      userId,
      {
        maxEntries: oldInvite.maxEntries,
        validFrom: oldInvite.validFrom || undefined,
        validUntil: oldInvite.validUntil || undefined,
      },
      ipAddress
    );

    await logAuditEvent(
      oldInvite.eventId,
      userId,
      'INVITATION_REISSUE',
      'event_invitations',
      newInvite.id,
      { oldInvitationId: invitationId },
      ipAddress
    );

    return newInvite;
  }

  /**
   * Fetches public invitation details by token or hash.
   */
  async getPublicInvitation(tokenOrHash: string) {
    const candidates = this.tokenHashCandidates(tokenOrHash);
    if (candidates.length === 0) return null;

    const rows = await db
      .select({
        invitation: eventInvitations,
        guest: eventGuests,
        event: events,
      })
      .from(eventInvitations)
      .innerJoin(eventGuests, eq(eventInvitations.guestId, eventGuests.id))
      .innerJoin(events, eq(eventInvitations.eventId, events.id))
      .where(inArray(eventInvitations.tokenHash, candidates))
      .limit(1);

    if (rows.length === 0) return null;

    const { invitation, guest, event } = rows[0];

    // Compute dynamic QR code (using token if supplied, or tokenHash)
    const qrTarget = `${env.FRONTEND_URL}/convite/${encodeURIComponent(tokenOrHash.trim())}`;
    const qrCodeUrl = await generateQRCode(qrTarget);

    return {
      invitation: {
        id: invitation.id,
        status: invitation.status,
        maxEntries: invitation.maxEntries,
        usedEntries: invitation.usedEntries,
        validFrom: invitation.validFrom,
        validUntil: invitation.validUntil,
        issuedAt: invitation.issuedAt,
        qrCodeUrl,
      },
      guest: {
        id: guest.id,
        name: guest.name,
        category: guest.category,
      },
      event: {
        id: event.id,
        uuid: event.uuid,
        title: event.title,
        description: event.description,
        category: event.category,
        startAt: event.startAt || event.startDate || event.eventDate,
        endAt: event.endAt || event.endDate,
        location: event.location,
        coverImage: event.coverImage,
        backgroundImage: event.backgroundImage,
      },
    };
  }

  /**
   * Generates a PDF buffer of an invitation for printing or download.
   */
  async generatePDF(invitationId: number): Promise<Buffer> {
    const rows = await db
      .select({
        invitation: eventInvitations,
        guest: eventGuests,
        event: events,
      })
      .from(eventInvitations)
      .innerJoin(eventGuests, eq(eventInvitations.guestId, eventGuests.id))
      .innerJoin(events, eq(eventInvitations.eventId, events.id))
      .where(eq(eventInvitations.id, invitationId))
      .limit(1);

    if (rows.length === 0) {
      throw new Error('Convite não encontrado.');
    }

    const { invitation, guest, event } = rows[0];

    const qrTarget = `${env.FRONTEND_URL}/convite/${invitation.tokenHash}`;
    const qrDataUrl = await generateQRCode(qrTarget);
    const qrBase64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');
    const qrBuffer = Buffer.from(qrBase64, 'base64');

    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A5', margin: 40 });
      const buffers: Buffer[] = [];

      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      // Header Banner / Title
      doc.rect(0, 0, doc.page.width, 90).fill('#1E293B');
      doc.fillColor('#FFFFFF').fontSize(22).font('Helvetica-Bold')
         .text(event.title || 'FotoQR Convite', 40, 32, { align: 'center', width: doc.page.width - 80 });

      doc.moveDown(4);

      // Guest Name & Category
      doc.fillColor('#0F172A').fontSize(18).font('Helvetica-Bold')
         .text(guest.name, { align: 'center' });
      doc.fillColor('#6366F1').fontSize(12).font('Helvetica')
         .text(`Categoria: ${guest.category}`, { align: 'center' });

      doc.moveDown(1.5);

      // Event Details Box
      const eventDate = event.startAt || event.startDate || event.eventDate;
      if (eventDate) {
        doc.fillColor('#475569').fontSize(11).font('Helvetica')
           .text(`Data: ${new Date(eventDate).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, { align: 'center' });
      }

      if (event.location) {
        doc.fillColor('#475569').fontSize(11).font('Helvetica')
           .text(`Local: ${event.location}`, { align: 'center' });
      }

      doc.moveDown(1.5);

      // Embed QR Code
      const qrSize = 160;
      const qrX = (doc.page.width - qrSize) / 2;
      doc.image(qrBuffer, qrX, doc.y, { width: qrSize, height: qrSize });
      doc.y += qrSize + 15;

      // Instructions
      doc.fillColor('#64748B').fontSize(10).font('Helvetica')
         .text('Apresente este QR Code na portaria do evento para liberação de acesso.', { align: 'center' });
      doc.text(`Entradas permitidas: ${invitation.maxEntries}`, { align: 'center' });

      doc.end();
    });
  }
}

export const invitationService = new InvitationService();
export default invitationService;

