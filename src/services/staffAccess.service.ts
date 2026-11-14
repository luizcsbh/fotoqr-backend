import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { env } from '../config/env.js';
import { eventDjs, eventReaders, events, users } from '../models/schema.js';
import { deliveryService } from './delivery.service.js';
import { AuthUser, StaffScope } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

/**
 * Exclusive access links for event staff: DJs (playlist console) and readers (portaria / QR check-in).
 *
 * Link token: "<d|r><row id>.<signature>", where the signature is an HMAC (server secret) over the
 * row id and a random nonce stored on the row. The owner can copy the link at any time, a database
 * dump alone cannot forge one, and regenerating the nonce revokes the previous link.
 *
 * Opening the link creates a *scoped* session (see StaffScope in middleware/auth.ts) that can only
 * use that staff console — never the dashboard or any other part of the app.
 */
export type StaffKind = 'dj' | 'reader';

export class StaffAccessError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

const KIND_PREFIX: Record<StaffKind, string> = { dj: 'd', reader: 'r' };
const TABLES = { dj: eventDjs, reader: eventReaders } as const;
const STAFF_SESSION_TTL = '7d';

const KIND_LABEL: Record<StaffKind, { role: string; console: string }> = {
  dj: { role: 'DJ', console: 'painel do DJ, onde você vê e organiza os pedidos de música dos convidados' },
  reader: { role: 'leitor da portaria', console: 'leitor de QR Code da portaria, para validar os convites na entrada' },
};

function sign(kind: StaffKind, rowId: number, nonce: string): string {
  return crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update(`staff-access:${kind}:${rowId}:${nonce}`)
    .digest('base64url')
    .slice(0, 32);
}

function buildToken(kind: StaffKind, rowId: number, nonce: string): string {
  return `${KIND_PREFIX[kind]}${rowId}.${sign(kind, rowId, nonce)}`;
}

export function accessUrlForToken(token: string): string {
  return `${env.FRONTEND_URL}/acesso/${token}`;
}

/** Nonce of the staff row, creating one the first time a link is needed. */
async function ensureNonce(kind: StaffKind, rowId: number): Promise<string> {
  const table = TABLES[kind];
  const [row] = await db.select({ nonce: table.accessNonce }).from(table).where(eq(table.id, rowId)).limit(1);
  if (!row) throw new StaffAccessError('Acesso não encontrado.', 404);
  if (row.nonce) return row.nonce;

  const nonce = crypto.randomBytes(24).toString('hex');
  await db.update(table).set({ accessNonce: nonce }).where(eq(table.id, rowId));
  return nonce;
}

/** Row of the staff member for this event/user (active or not). */
async function findRow(kind: StaffKind, eventId: number, userId: number) {
  const table = TABLES[kind];
  const [row] = await db
    .select({ id: table.id, active: table.active })
    .from(table)
    .where(and(eq(table.eventId, eventId), eq(table.userId, userId)))
    .limit(1);
  if (!row) throw new StaffAccessError(kind === 'dj' ? 'DJ não encontrado neste evento.' : 'Leitor não encontrado neste evento.', 404);
  return row;
}

export const staffAccessService = {
  /** Exclusive link of a staff member (creates its secret on first use). */
  async getAccessLink(kind: StaffKind, eventId: number, userId: number): Promise<string> {
    const row = await findRow(kind, eventId, userId);
    return accessUrlForToken(buildToken(kind, row.id, await ensureNonce(kind, row.id)));
  },

  /** Issues a new link and revokes the previous one. */
  async regenerateAccessLink(kind: StaffKind, eventId: number, userId: number): Promise<string> {
    const row = await findRow(kind, eventId, userId);
    const nonce = crypto.randomBytes(24).toString('hex');
    await db.update(TABLES[kind]).set({ accessNonce: nonce }).where(eq(TABLES[kind].id, row.id));
    return accessUrlForToken(buildToken(kind, row.id, nonce));
  },

  /** E-mails the exclusive link to the staff member. Throws when e-mail is not configured or fails. */
  async sendAccessEmail(kind: StaffKind, eventId: number, userId: number): Promise<void> {
    if (!deliveryService.isEmailConfigured()) {
      throw new StaffAccessError('O envio de e-mail não está configurado no servidor. Copie o link e envie manualmente.', 503);
    }

    const [info] = await db
      .select({ email: users.email, name: users.name, eventTitle: events.title })
      .from(users)
      .innerJoin(events, eq(events.id, eventId))
      .where(eq(users.id, userId))
      .limit(1);
    if (!info) throw new StaffAccessError('Destinatário não encontrado.', 404);

    const link = await this.getAccessLink(kind, eventId, userId);
    const label = KIND_LABEL[kind];
    const escape = (value: string) =>
      value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

    await deliveryService.sendMail({
      to: info.email,
      subject: `Seu acesso de ${label.role} — ${info.eventTitle}`,
      html: `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1e293b">
          <h2 style="margin:0 0 12px">Olá, ${escape(info.name)}!</h2>
          <p>Você foi convidado(a) como <strong>${label.role}</strong> do evento <strong>${escape(info.eventTitle)}</strong>.</p>
          <p>Use o botão abaixo para abrir o ${label.console}. Não é preciso criar senha.</p>
          <p style="margin:28px 0;text-align:center">
            <a href="${link}" style="background:#059669;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:bold;display:inline-block">
              Abrir meu acesso
            </a>
          </p>
          <p style="font-size:13px;color:#64748b">Se o botão não funcionar, copie este endereço no navegador:<br>
            <a href="${link}" style="color:#059669;word-break:break-all">${link}</a></p>
          <p style="font-size:13px;color:#64748b">Este link é pessoal e dá acesso apenas a esta função no evento. Não o compartilhe.</p>
        </div>`,
    });
    logger.info(`[staff-access] Link de ${kind} enviado por e-mail (evento ${eventId}, usuário ${userId})`);
  },

  /**
   * Validates a link token and returns the scoped session to open, or null when the link is
   * invalid, revoked, or the staff member was deauthorized.
   */
  async resolveToken(token: string) {
    const match = /^([dr])(\d{1,10})\.([A-Za-z0-9_-]{32})$/.exec(String(token || '').trim());
    if (!match) return null;
    const kind: StaffKind = match[1] === 'd' ? 'dj' : 'reader';
    const rowId = Number(match[2]);
    const table = TABLES[kind];

    const [row] = await db
      .select({
        nonce: table.accessNonce,
        active: table.active,
        eventId: events.id,
        eventUuid: events.uuid,
        eventTitle: events.title,
        userId: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        tokenVersion: users.tokenVersion,
      })
      .from(table)
      .innerJoin(users, eq(users.id, table.userId))
      .innerJoin(events, eq(events.id, table.eventId))
      .where(eq(table.id, rowId))
      .limit(1);

    if (!row || !row.active || !row.nonce) return null;
    const expected = Buffer.from(sign(kind, rowId, row.nonce));
    const given = Buffer.from(match[3]);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;

    const scope: StaffScope = { kind, eventId: row.eventId, eventUuid: row.eventUuid };
    const payload: AuthUser = {
      id: row.userId,
      email: row.email,
      name: row.name,
      role: row.role,
      tv: row.tokenVersion ?? 0,
      scope,
    };
    return {
      scope,
      eventTitle: row.eventTitle,
      sessionToken: jwt.sign(payload, env.JWT_SECRET, { expiresIn: STAFF_SESSION_TTL }),
    };
  },
};

export default staffAccessService;
