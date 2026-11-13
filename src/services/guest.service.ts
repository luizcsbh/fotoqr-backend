import { db } from '../config/database.js';
import { eventGuests, EventGuest, NewEventGuest } from '../models/schema.js';
import { eq, and, or, ilike, desc, sql } from 'drizzle-orm';
import { logAuditEvent } from './audit.service.js';
import * as xlsx from 'xlsx';

export interface CreateGuestDTO {
  name: string;
  email?: string | null;
  phone?: string | null;
  category?: string;
  notes?: string | null;
  externalId?: string | null;
}

export interface UpdateGuestDTO {
  name?: string;
  email?: string | null;
  phone?: string | null;
  category?: string;
  notes?: string | null;
  externalId?: string | null;
}

export interface GuestListQuery {
  search?: string;
  category?: string;
  page?: number;
  limit?: number;
}

export interface ImportResult {
  total: number;
  imported: number;
  duplicates: number;
  errors: Array<{ row: number; reason: string }>;
}

export class GuestService {
  /**
   * Sanitizes and normalizes phone numbers (keeps only digits).
   */
  normalizePhone(phone?: string | null): string | null {
    if (!phone) return null;
    const cleaned = phone.replace(/\D/g, '');
    return cleaned.length > 0 ? cleaned : null;
  }

  /**
   * Validates guest input.
   */
  validateGuestData(data: CreateGuestDTO): void {
    for (const key of ['name', 'email', 'phone', 'category', 'notes', 'externalId'] as const) {
      const value = data[key];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw new Error(`O campo "${key}" do convidado é inválido.`);
      }
    }
    if (!data.name || data.name.trim().length < 2) {
      throw new Error('O nome do convidado é obrigatório (mínimo de 2 caracteres).');
    }

    if (data.email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(data.email.trim())) {
        throw new Error('E-mail informado é inválido.');
      }
    }
  }

  /**
   * Checks if guest already exists in the same event by email or phone.
   */
  async findDuplicate(
    eventId: number,
    email?: string | null,
    phone?: string | null,
    excludeGuestId?: number
  ): Promise<EventGuest | null> {
    const conditions = [];

    const normEmail = email?.trim().toLowerCase();
    if (normEmail) {
      conditions.push(sql`lower(${eventGuests.email}) = ${normEmail}`);
    }

    const normPhone = this.normalizePhone(phone);
    if (normPhone) {
      conditions.push(sql`regexp_replace(${eventGuests.phone}, '\\D', '', 'g') = ${normPhone}`);
    }

    if (conditions.length === 0) return null;

    let baseQuery = db
      .select()
      .from(eventGuests)
      .where(and(eq(eventGuests.eventId, eventId), or(...conditions)));

    const rows = await baseQuery;
    const match = rows.find((r) => !excludeGuestId || r.id !== excludeGuestId);
    return match || null;
  }

  /**
   * Adds an individual guest.
   */
  async createGuest(
    eventId: number,
    userId: number,
    data: CreateGuestDTO,
    ipAddress?: string
  ): Promise<EventGuest> {
    this.validateGuestData(data);

    const normEmail = data.email ? data.email.trim().toLowerCase() : null;
    const normPhone = data.phone ? data.phone.trim() : null;

    // Check duplicate
    const duplicate = await this.findDuplicate(eventId, normEmail, normPhone);
    if (duplicate) {
      throw new Error(`Convidado já cadastrado neste evento com estes dados (${duplicate.name}).`);
    }

    const [guest] = await db
      .insert(eventGuests)
      .values({
        eventId,
        name: data.name.trim(),
        email: normEmail,
        phone: normPhone,
        category: data.category?.trim() || 'Convidado',
        notes: data.notes?.trim() || null,
        externalId: data.externalId?.trim() || null,
      })
      .returning();

    await logAuditEvent(eventId, userId, 'GUEST_CREATE', 'event_guests', guest.id, { guestName: guest.name }, ipAddress);

    return guest;
  }

  /**
   * Lists guests with search, filters and pagination.
   */
  async listGuests(eventId: number, query: GuestListQuery) {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 50));
    const offset = (page - 1) * limit;

    const whereConditions = [eq(eventGuests.eventId, eventId)];

    if (query.category) {
      whereConditions.push(eq(eventGuests.category, query.category));
    }

    if (query.search) {
      const term = `%${query.search.trim()}%`;
      whereConditions.push(
        or(
          ilike(eventGuests.name, term),
          ilike(eventGuests.email, term),
          ilike(eventGuests.phone, term)
        )!
      );
    }

    const [totalRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(eventGuests)
      .where(and(...whereConditions));

    const total = totalRow?.count || 0;

    const items = await db
      .select()
      .from(eventGuests)
      .where(and(...whereConditions))
      .orderBy(desc(eventGuests.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Updates guest details.
   */
  async updateGuest(
    guestId: number,
    userId: number,
    data: UpdateGuestDTO,
    ipAddress?: string
  ): Promise<EventGuest> {
    const [existing] = await db
      .select()
      .from(eventGuests)
      .where(eq(eventGuests.id, guestId))
      .limit(1);

    if (!existing) {
      throw new Error('Convidado não encontrado.');
    }

    for (const key of ['name', 'email', 'phone', 'category', 'notes', 'externalId'] as const) {
      const value = data[key];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw new Error(`O campo "${key}" do convidado é inválido.`);
      }
    }

    if (data.name !== undefined && (!data.name || data.name.trim().length < 2)) {
      throw new Error('O nome do convidado deve ter pelo menos 2 caracteres.');
    }

    if (data.email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(data.email.trim())) {
        throw new Error('E-mail informado é inválido.');
      }
    }

    const normEmail = data.email !== undefined ? (data.email ? data.email.trim().toLowerCase() : null) : existing.email;
    const normPhone = data.phone !== undefined ? (data.phone ? data.phone.trim() : null) : existing.phone;

    if (normEmail || normPhone) {
      const duplicate = await this.findDuplicate(existing.eventId, normEmail, normPhone, guestId);
      if (duplicate) {
        throw new Error(`Outro convidado já está cadastrado com estes dados (${duplicate.name}).`);
      }
    }

    const [updated] = await db
      .update(eventGuests)
      .set({
        name: data.name !== undefined ? data.name.trim() : existing.name,
        email: normEmail,
        phone: normPhone,
        category: data.category ? data.category.trim() || existing.category : existing.category,
        notes: data.notes !== undefined ? (data.notes ? data.notes.trim() : null) : existing.notes,
        externalId: data.externalId !== undefined ? (data.externalId ? data.externalId.trim() : null) : existing.externalId,
        updatedAt: new Date(),
      })
      .where(eq(eventGuests.id, guestId))
      .returning();

    await logAuditEvent(existing.eventId, userId, 'GUEST_UPDATE', 'event_guests', guestId, { changes: data }, ipAddress);

    return updated;
  }

  /**
   * Deletes a guest.
   */
  async deleteGuest(eventId: number, guestId: number, userId: number, ipAddress?: string): Promise<void> {
    const [existing] = await db
      .select()
      .from(eventGuests)
      .where(and(eq(eventGuests.id, guestId), eq(eventGuests.eventId, eventId)))
      .limit(1);

    if (!existing) {
      throw new Error('Convidado não encontrado.');
    }

    await db.delete(eventGuests).where(eq(eventGuests.id, guestId));

    await logAuditEvent(existing.eventId, userId, 'GUEST_DELETE', 'event_guests', guestId, { guestName: existing.name }, ipAddress);
  }

  /**
   * Imports guests from a file buffer (CSV or XLSX) or array of objects.
   */
  async importGuests(
    eventId: number,
    userId: number,
    fileBuffer: Buffer,
    filename: string,
    ipAddress?: string
  ): Promise<ImportResult> {
    const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw new Error('A planilha enviada está vazia ou ilegível.');
    }

    const sheet = workbook.Sheets[sheetName];
    const rawRows = xlsx.utils.sheet_to_json<Record<string, any>>(sheet);

    if (!rawRows || rawRows.length === 0) {
      return { total: 0, imported: 0, duplicates: 0, errors: [] };
    }

    let imported = 0;
    let duplicates = 0;
    const errors: Array<{ row: number; reason: string }> = [];

    for (let i = 0; i < rawRows.length; i++) {
      const row = rawRows[i];
      const rowIndex = i + 2; // header is row 1

      // Flexible column name matching (case insensitive, pt/en)
      const name = row['Nome'] || row['nome'] || row['Name'] || row['name'] || row['CONVIDADO'] || row['convidado'];
      const email = row['Email'] || row['email'] || row['E-mail'] || row['e-mail'];
      const phone = row['Telefone'] || row['telefone'] || row['Phone'] || row['phone'] || row['WhatsApp'] || row['whatsapp'] || row['Celular'];
      const category = row['Categoria'] || row['categoria'] || row['Category'] || row['category'] || 'Convidado';
      const notes = row['Observações'] || row['observacoes'] || row['Notas'] || row['notes'];
      const externalId = row['ID'] || row['id'] || row['Identificador'] || row['external_id'];

      if (!name || String(name).trim().length < 2) {
        errors.push({ row: rowIndex, reason: 'Nome ausente ou inválido.' });
        continue;
      }

      const guestData: CreateGuestDTO = {
        name: String(name).trim(),
        email: email ? String(email).trim().toLowerCase() : null,
        phone: phone ? String(phone).trim() : null,
        category: category ? String(category).trim() : 'Convidado',
        notes: notes ? String(notes).trim() : null,
        externalId: externalId ? String(externalId).trim() : null,
      };

      try {
        this.validateGuestData(guestData);

        const dup = await this.findDuplicate(eventId, guestData.email, guestData.phone);
        if (dup) {
          duplicates++;
          continue;
        }

        await db.insert(eventGuests).values({
          eventId,
          name: guestData.name,
          email: guestData.email,
          phone: guestData.phone,
          category: guestData.category || 'Convidado',
          notes: guestData.notes,
          externalId: guestData.externalId,
        });

        imported++;
      } catch (err: any) {
        errors.push({ row: rowIndex, reason: err.message || 'Erro ao processar linha' });
      }
    }

    await logAuditEvent(
      eventId,
      userId,
      'GUEST_IMPORT',
      'event_guests',
      undefined,
      { total: rawRows.length, imported, duplicates, errorsCount: errors.length, filename },
      ipAddress
    );

    return {
      total: rawRows.length,
      imported,
      duplicates,
      errors,
    };
  }
}

export const guestService = new GuestService();
export default guestService;

