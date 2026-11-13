import { db } from '../config/database.js';
import {
  events,
  eventGuests,
  eventInvitations,
  eventCheckins,
  eventReaders,
  invitationDeliveries,
  users,
} from '../models/schema.js';
import { eq, and, sql, desc } from 'drizzle-orm';
import * as xlsx from 'xlsx';

export interface DashboardMetrics {
  totalGuests: number;
  totalInvitations: number;
  sentEmail: number;
  sentWhatsApp: number;
  pendingDeliveries: number;
  failedDeliveries: number;
  totalCheckins: number;
  absentGuests: number;
  attendanceRate: number; // percentage (0 - 100)
  recentCheckins: Array<{
    id: number;
    guestName: string;
    category: string;
    checkedInAt: Date;
    readerName: string | null;
    result: string;
  }>;
  categoryBreakdown: Array<{ category: string; total: number; present: number }>;
}

export class ReportService {
  /**
   * Fetches real-time dashboard indicators for an event.
   */
  async getDashboardMetrics(eventId: number): Promise<DashboardMetrics> {
    // 1. Total Guests
    const [guestCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(eventGuests)
      .where(eq(eventGuests.eventId, eventId));
    const totalGuests = guestCountRow?.count || 0;

    // 2. Total Invitations
    const [invitationCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(eventInvitations)
      .where(eq(eventInvitations.eventId, eventId));
    const totalInvitations = invitationCountRow?.count || 0;

    // 3. Deliveries breakdown
    const deliveryRows = await db
      .select({
        channel: invitationDeliveries.channel,
        status: invitationDeliveries.status,
        count: sql<number>`count(*)::int`,
      })
      .from(invitationDeliveries)
      .innerJoin(eventInvitations, eq(invitationDeliveries.invitationId, eventInvitations.id))
      .where(eq(eventInvitations.eventId, eventId))
      .groupBy(invitationDeliveries.channel, invitationDeliveries.status);

    let sentEmail = 0;
    let sentWhatsApp = 0;
    let pendingDeliveries = 0;
    let failedDeliveries = 0;

    for (const r of deliveryRows) {
      if (r.status === 'sent') {
        if (r.channel === 'email') sentEmail += r.count;
        if (r.channel === 'whatsapp') sentWhatsApp += r.count;
      } else if (r.status === 'pending') {
        pendingDeliveries += r.count;
      } else if (r.status === 'failed') {
        failedDeliveries += r.count;
      }
    }

    // 4. Valid check-ins (distinct guests who entered)
    const [checkinsRow] = await db
      .select({
        totalCheckins: sql<number>`count(distinct ${eventCheckins.guestId})::int`,
      })
      .from(eventCheckins)
      .where(and(eq(eventCheckins.eventId, eventId), eq(eventCheckins.result, 'VALIDO')));

    const totalCheckins = checkinsRow?.totalCheckins || 0;
    const absentGuests = Math.max(0, totalGuests - totalCheckins);
    const attendanceRate = totalGuests > 0 ? Math.round((totalCheckins / totalGuests) * 100) : 0;

    // 5. Recent check-ins
    const recentCheckinsRows = await db
      .select({
        id: eventCheckins.id,
        guestName: eventGuests.name,
        category: eventGuests.category,
        checkedInAt: eventCheckins.checkedInAt,
        readerName: users.name,
        result: eventCheckins.result,
      })
      .from(eventCheckins)
      .innerJoin(eventGuests, eq(eventCheckins.guestId, eventGuests.id))
      .leftJoin(users, eq(eventCheckins.readerUserId, users.id))
      .where(eq(eventCheckins.eventId, eventId))
      .orderBy(desc(eventCheckins.checkedInAt))
      .limit(10);

    // 6. Category breakdown
    const categoryRows = await db
      .select({
        category: eventGuests.category,
        total: sql<number>`count(*)::int`,
      })
      .from(eventGuests)
      .where(eq(eventGuests.eventId, eventId))
      .groupBy(eventGuests.category);

    const categoryPresentRows = await db
      .select({
        category: eventGuests.category,
        present: sql<number>`count(distinct ${eventCheckins.guestId})::int`,
      })
      .from(eventCheckins)
      .innerJoin(eventGuests, eq(eventCheckins.guestId, eventGuests.id))
      .where(and(eq(eventCheckins.eventId, eventId), eq(eventCheckins.result, 'VALIDO')))
      .groupBy(eventGuests.category);

    const presentMap = new Map<string, number>();
    categoryPresentRows.forEach((r) => presentMap.set(r.category, r.present));

    const categoryBreakdown = categoryRows.map((c) => ({
      category: c.category,
      total: c.total,
      present: presentMap.get(c.category) || 0,
    }));

    return {
      totalGuests,
      totalInvitations,
      sentEmail,
      sentWhatsApp,
      pendingDeliveries,
      failedDeliveries,
      totalCheckins,
      absentGuests,
      attendanceRate,
      recentCheckins: recentCheckinsRows,
      categoryBreakdown,
    };
  }

  /**
   * Generates CSV / Excel export for guests, check-ins, or absences.
   */
  async exportReport(eventId: number, type: 'guests' | 'checkins' | 'absent' | 'deliveries', format: 'xlsx' | 'csv' = 'xlsx'): Promise<Buffer> {
    let data: any[] = [];

    if (type === 'guests') {
      const rows = await db
        .select({
          ID: eventGuests.id,
          Nome: eventGuests.name,
          Email: eventGuests.email,
          Telefone: eventGuests.phone,
          Categoria: eventGuests.category,
          Observações: eventGuests.notes,
          DataCadastro: eventGuests.createdAt,
        })
        .from(eventGuests)
        .where(eq(eventGuests.eventId, eventId))
        .orderBy(eventGuests.name);

      data = rows;
    } else if (type === 'checkins') {
      const rows = await db
        .select({
          ID: eventCheckins.id,
          Convidado: eventGuests.name,
          Categoria: eventGuests.category,
          HorárioEntrada: eventCheckins.checkedInAt,
          Resultado: eventCheckins.result,
          Leitor: users.name,
          Dispositivo: eventCheckins.deviceIdentifier,
        })
        .from(eventCheckins)
        .innerJoin(eventGuests, eq(eventCheckins.guestId, eventGuests.id))
        .leftJoin(users, eq(eventCheckins.readerUserId, users.id))
        .where(eq(eventCheckins.eventId, eventId))
        .orderBy(desc(eventCheckins.checkedInAt));

      data = rows;
    } else if (type === 'absent') {
      const rows = await db
        .select({
          ID: eventGuests.id,
          Nome: eventGuests.name,
          Email: eventGuests.email,
          Telefone: eventGuests.phone,
          Categoria: eventGuests.category,
        })
        .from(eventGuests)
        .where(
          and(
            eq(eventGuests.eventId, eventId),
            sql`${eventGuests.id} NOT IN (SELECT guest_id FROM event_checkins WHERE event_id = ${eventId} AND result = 'VALIDO')`
          )
        )
        .orderBy(eventGuests.name);

      data = rows;
    } else if (type === 'deliveries') {
      const rows = await db
        .select({
          ID: invitationDeliveries.id,
          Canal: invitationDeliveries.channel,
          Destino: invitationDeliveries.destination,
          Status: invitationDeliveries.status,
          Tentativas: invitationDeliveries.attempts,
          Erro: invitationDeliveries.errorMessage,
          DataEnvio: invitationDeliveries.sentAt,
        })
        .from(invitationDeliveries)
        .innerJoin(eventInvitations, eq(invitationDeliveries.invitationId, eventInvitations.id))
        .where(eq(eventInvitations.eventId, eventId))
        .orderBy(desc(invitationDeliveries.createdAt));

      data = rows;
    }

    const worksheet = xlsx.utils.json_to_sheet(data);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'Relatório');

    if (format === 'csv') {
      const csvStr = xlsx.utils.sheet_to_csv(worksheet);
      return Buffer.from(csvStr, 'utf-8');
    }

    return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  }
}

export const reportService = new ReportService();
export default reportService;

