import nodemailer from 'nodemailer';
import { db } from '../config/database.js';
import {
  invitationDeliveries,
  eventInvitations,
  eventGuests,
  events,
} from '../models/schema.js';
import { eq, and, inArray, ne } from 'drizzle-orm';
import { invitationService } from './invitation.service.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { logAuditEvent } from './audit.service.js';

export interface DispatchSummary {
  total: number;
  sent: number;
  failed: number;
  details: Array<{ invitationId: number; channel: string; destination: string; status: string; error?: string }>;
}

export class DeliveryService {
  /**
   * Configures nodemailer transport.
   * If SMTP is configured in env, uses it. Otherwise falls back to mock/stream transporter.
   */
  getMailTransporter() {
    const smtpHost = env.SMTP_HOST;
    const smtpUser = env.SMTP_USER;
    const smtpPass = env.SMTP_PASS;
    const smtpPort = env.SMTP_PORT;

    if (smtpHost && smtpUser && smtpPass) {
      return nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: env.SMTP_SECURE,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });
    }

    // Development / fallback transporter that writes to log
    return nodemailer.createTransport({
      streamTransport: true,
      newline: 'windows',
    });
  }

  /**
   * Generates responsive HTML email for an invitation.
   */
  generateEmailHtml(guestName: string, eventTitle: string, inviteUrl: string, eventDate?: Date | null, location?: string | null): string {
    const formattedDate = eventDate ? new Date(eventDate).toLocaleString('pt-BR') : 'A definir';

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Seu Convite para ${eventTitle}</title>
      </head>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 24px; color: #1e293b;">
        <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
          <tr>
            <td style="background-color: #4f46e5; padding: 32px 24px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 700;">${eventTitle}</h1>
              <p style="color: #c7d2fe; margin: 8px 0 0 0; font-size: 15px;">Convite Oficial com QR Code</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px 24px;">
              <p style="font-size: 16px; margin: 0 0 16px 0;">Olá, <strong>${guestName}</strong>!</p>
              <p style="font-size: 15px; line-height: 1.6; color: #475569; margin: 0 0 24px 0;">
                Você foi convidado(a) especial para o evento <strong>${eventTitle}</strong>. Seu convite digital com QR Code já está disponível para acesso e validação na entrada.
              </p>
              <div style="background-color: #f8fafc; border-left: 4px solid #4f46e5; padding: 16px; border-radius: 6px; margin-bottom: 24px;">
                <p style="margin: 0 0 8px 0; font-size: 14px;"><strong>📅 Data:</strong> ${formattedDate}</p>
                <p style="margin: 0; font-size: 14px;"><strong>📍 Local:</strong> ${location || 'Divulgado pelo organizador'}</p>
              </div>
              <div style="text-align: center; margin: 32px 0;">
                <a href="${inviteUrl}" target="_blank" style="background-color: #4f46e5; color: #ffffff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px; display: inline-block;">
                  Acessar Meu Convite e QR Code
                </a>
              </div>
              <p style="font-size: 13px; color: #94a3b8; text-align: center; margin: 0;">
                Apresente o QR Code na tela do seu celular no momento do check-in.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #f8fafc; padding: 20px 24px; text-align: center; border-top: 1px solid #e2e8f0;">
              <p style="font-size: 12px; color: #94a3b8; margin: 0;">
                Enviado com segurança pela plataforma <strong>FotoQR</strong>.
              </p>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;
  }

  /**
   * Dispatches an individual invitation via Email.
   */
  async sendEmail(invitationId: number, userId: number, attachPdf = false, ipAddress?: string): Promise<boolean> {
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

    if (!guest.email) {
      throw new Error(`O convidado ${guest.name} não possui e-mail cadastrado.`);
    }

    const inviteUrl = `${env.FRONTEND_URL}/convite/${invitation.tokenHash}`;
    const html = this.generateEmailHtml(
      guest.name,
      event.title,
      inviteUrl,
      event.startAt || event.startDate || event.eventDate,
      event.location
    );

    const [deliveryRecord] = await db
      .insert(invitationDeliveries)
      .values({
        invitationId,
        channel: 'email',
        destination: guest.email,
        status: 'pending',
        attempts: 1,
      })
      .returning();

    try {
      const transporter = this.getMailTransporter();
      const attachments = [];

      if (attachPdf) {
        const pdfBuffer = await invitationService.generatePDF(invitationId);
        attachments.push({
          filename: `convite-${guest.name.toLowerCase().replace(/\s+/g, '-')}.pdf`,
          content: pdfBuffer,
        });
      }

      const info = await transporter.sendMail({
        from: env.SMTP_FROM,
        to: guest.email,
        subject: `Seu convite para ${event.title}`,
        html,
        attachments,
      });

      await db
        .update(invitationDeliveries)
        .set({
          status: 'sent',
          providerMessageId: info.messageId || 'local-stream',
          sentAt: new Date(),
        })
        .where(eq(invitationDeliveries.id, deliveryRecord.id));

      await db
        .update(eventInvitations)
        .set({ status: 'sent', updatedAt: new Date() })
        .where(eq(eventInvitations.id, invitationId));

      await logAuditEvent(
        event.id,
        userId,
        'DELIVERY_EMAIL_SENT',
        'invitation_deliveries',
        deliveryRecord.id,
        { destination: guest.email, guestName: guest.name },
        ipAddress
      );

      return true;
    } catch (err: any) {
      logger.error(`Erro ao disparar e-mail para ${guest.email}:`, err);

      await db
        .update(invitationDeliveries)
        .set({
          status: 'failed',
          errorMessage: err.message || 'Falha no envio de e-mail',
        })
        .where(eq(invitationDeliveries.id, deliveryRecord.id));

      return false;
    }
  }

  /**
   * Dispatches an individual invitation via WhatsApp (Cloud API or Fallback).
   */
  async sendWhatsApp(invitationId: number, userId: number, ipAddress?: string): Promise<boolean> {
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

    if (!guest.phone) {
      throw new Error(`O convidado ${guest.name} não possui telefone cadastrado.`);
    }

    const inviteUrl = `${env.FRONTEND_URL}/convite/${invitation.tokenHash}`;
    const destination = guest.phone.replace(/\D/g, '');

    const [deliveryRecord] = await db
      .insert(invitationDeliveries)
      .values({
        invitationId,
        channel: 'whatsapp',
        destination,
        status: 'pending',
        attempts: 1,
      })
      .returning();

    const waToken = process.env.WHATSAPP_API_TOKEN;
    const waPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    try {
      let providerMessageId = 'wa-mock-' + Date.now();

      if (waToken && waPhoneId) {
        // Disparar via Meta WhatsApp Cloud API
        const waResponse = await fetch(`https://graph.facebook.com/v19.0/${waPhoneId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${waToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: destination,
            type: 'text',
            text: {
              preview_url: true,
              body: `Olá ${guest.name}! Você recebeu seu convite para *${event.title}*.\n\nAcesse seu QR Code individual de entrada pelo link seguro:\n${inviteUrl}`,
            },
          }),
        });

        const resData: any = await waResponse.json();
        if (!waResponse.ok) {
          throw new Error(resData?.error?.message || 'Falha na WhatsApp Cloud API');
        }

        providerMessageId = resData?.messages?.[0]?.id || providerMessageId;
      } else {
        logger.info(`[WhatsApp Simulado / Fallback] Enviado para ${destination}: Convite ${event.title} - ${inviteUrl}`);
      }

      await db
        .update(invitationDeliveries)
        .set({
          status: 'sent',
          providerMessageId,
          sentAt: new Date(),
        })
        .where(eq(invitationDeliveries.id, deliveryRecord.id));

      await db
        .update(eventInvitations)
        .set({ status: 'sent', updatedAt: new Date() })
        .where(eq(eventInvitations.id, invitationId));

      await logAuditEvent(
        event.id,
        userId,
        'DELIVERY_WHATSAPP_SENT',
        'invitation_deliveries',
        deliveryRecord.id,
        { destination, guestName: guest.name },
        ipAddress
      );

      return true;
    } catch (err: any) {
      logger.error(`Erro ao disparar WhatsApp para ${destination}:`, err);

      await db
        .update(invitationDeliveries)
        .set({
          status: 'failed',
          errorMessage: err.message || 'Falha no envio de WhatsApp',
        })
        .where(eq(invitationDeliveries.id, deliveryRecord.id));

      return false;
    }
  }

  /**
   * Batch dispatch to multiple invitations (Email or WhatsApp).
   */
  async dispatchBatch(
    eventId: number,
    userId: number,
    channel: 'email' | 'whatsapp',
    invitationIds?: number[],
    attachPdf = false,
    ipAddress?: string
  ): Promise<DispatchSummary> {
    let targets: Array<{ id: number }> = [];

    if (invitationIds && invitationIds.length > 0) {
      targets = await db
        .select({ id: eventInvitations.id })
        .from(eventInvitations)
        .where(and(eq(eventInvitations.eventId, eventId), inArray(eventInvitations.id, invitationIds)));
    } else {
      targets = await db
        .select({ id: eventInvitations.id })
        .from(eventInvitations)
        .where(and(eq(eventInvitations.eventId, eventId), ne(eventInvitations.status, 'cancelled')));
    }

    let sent = 0;
    let failed = 0;
    const details = [];

    for (const target of targets) {
      try {
        let success = false;
        if (channel === 'email') {
          success = await this.sendEmail(target.id, userId, attachPdf, ipAddress);
        } else {
          success = await this.sendWhatsApp(target.id, userId, ipAddress);
        }

        if (success) {
          sent++;
          details.push({ invitationId: target.id, channel, destination: 'OK', status: 'sent' });
        } else {
          failed++;
          details.push({ invitationId: target.id, channel, destination: '-', status: 'failed', error: 'Erro de entrega' });
        }
      } catch (err: any) {
        failed++;
        details.push({ invitationId: target.id, channel, destination: '-', status: 'failed', error: err.message });
      }
    }

    return {
      total: targets.length,
      sent,
      failed,
      details,
    };
  }
}

export const deliveryService = new DeliveryService();
export default deliveryService;

