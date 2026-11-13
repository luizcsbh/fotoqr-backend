import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import {
  requireEventAdmin,
  requireEventReader,
  canAdminEvent,
} from '../middleware/rbac.js';
import { guestService } from '../services/guest.service.js';
import { invitationService } from '../services/invitation.service.js';
import { deliveryService } from '../services/delivery.service.js';
import { checkinService } from '../services/checkin.service.js';
import { reportService } from '../services/report.service.js';
import { getEventAuditLogs } from '../services/audit.service.js';
import { db } from '../config/database.js';
import { events, eventInvitations, eventGuests, eventCheckins, users } from '../models/schema.js';
import { eq, desc } from 'drizzle-orm';

const router = Router();
const uploadDoc = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

// Cover / background images become data: URLs shown to every guest, so only real images are accepted
const COVER_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const uploadCover = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, callback) => {
    if (COVER_IMAGE_TYPES.includes(file.mimetype.toLowerCase())) {
      callback(null, true);
      return;
    }
    callback(new Error('Formato de arquivo inválido. Use uma imagem JPG, PNG, WEBP ou GIF.'));
  },
});

const REPORT_TYPES = ['guests', 'checkins', 'absent', 'deliveries'] as const;
const REPORT_FORMATS = ['xlsx', 'csv'] as const;

/** Positive integer from a route parameter, or null. */
const parseId = (raw: unknown): number | null => {
  const text = String(raw ?? '');
  return /^\d+$/.test(text) ? parseInt(text, 10) : null;
};

/** Keeps only valid numeric invitation ids from a request body (undefined = "all"). */
const parseIdList = (raw: unknown): number[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const ids = raw.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : undefined;
};

// Helper to extract IP
const getIp = (req: Request) => req.ip || req.socket.remoteAddress;

/* ==========================================================================
   1. Event Details & Cover Customization
   ========================================================================== */

/**
 * PUT /api/events/:id
 * Updates event details (name, category, location, capacity, dates, status).
 */
router.put('/events/:id', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = req.eventAccess!.eventId;
    const { title, name, description, category, startAt, endAt, location, capacity, status, maxEntriesPerInvitation } = req.body;

    const eventTitle = String(title || name || '').trim();
    if (eventTitle && eventTitle.length < 2) {
      res.status(400).json({ success: false, error: 'O nome do evento deve ter no mínimo 2 caracteres.' });
      return;
    }

    const updatePayload: Record<string, any> = { updatedAt: new Date() };
    if (eventTitle) updatePayload.title = eventTitle;
    if (description !== undefined) updatePayload.description = description;
    if (category !== undefined) updatePayload.category = category;
    if (startAt !== undefined) {
      updatePayload.startAt = startAt ? new Date(startAt) : null;
      updatePayload.startDate = updatePayload.startAt;
    }
    if (endAt !== undefined) {
      updatePayload.endAt = endAt ? new Date(endAt) : null;
      updatePayload.endDate = updatePayload.endAt;
    }
    if (location !== undefined) updatePayload.location = location;
    if (capacity !== undefined) updatePayload.capacity = Number(capacity) || null;
    if (status !== undefined) updatePayload.status = status;
    if (maxEntriesPerInvitation !== undefined) updatePayload.maxEntriesPerInvitation = Number(maxEntriesPerInvitation) || 1;

    const [updated] = await db
      .update(events)
      .set(updatePayload)
      .where(eq(events.id, eventId))
      .returning();

    res.status(200).json({
      success: true,
      message: 'Evento atualizado com sucesso.',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/events/:id/cover
 * Saves custom cover image and/or background image (via JSON URLs or file upload).
 */
router.post(
  '/events/:id/cover',
  authenticateToken,
  requireEventAdmin,
  uploadCover.fields([
    { name: 'coverFile', maxCount: 1 },
    { name: 'bgFile', maxCount: 1 },
  ]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const eventId = req.eventAccess!.eventId;
      let { coverImage, backgroundImage, location, startAt } = req.body || {};

      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

      if (files?.coverFile?.[0]) {
        const file = files.coverFile[0];
        const base64 = file.buffer.toString('base64');
        coverImage = `data:${file.mimetype};base64,${base64}`;
      }

      if (files?.bgFile?.[0]) {
        const file = files.bgFile[0];
        const base64 = file.buffer.toString('base64');
        backgroundImage = `data:${file.mimetype};base64,${base64}`;
      }

      const updateData: Record<string, any> = {
        updatedAt: new Date(),
      };
      if (coverImage !== undefined) updateData.coverImage = coverImage;
      if (backgroundImage !== undefined) updateData.backgroundImage = backgroundImage;
      if (location !== undefined) updateData.location = location;
      if (startAt !== undefined) {
        updateData.startAt = startAt ? new Date(startAt) : null;
        updateData.startDate = updateData.startAt;
      }

      const [updated] = await db
        .update(events)
        .set(updateData)
        .where(eq(events.id, eventId))
        .returning();

      res.status(200).json({
        success: true,
        message: 'Capa do evento atualizada com sucesso.',
        data: {
          coverImage: updated.coverImage,
          backgroundImage: updated.backgroundImage,
          location: updated.location,
          startAt: updated.startAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/* ==========================================================================
   2. Guest Management
   ========================================================================== */

/**
 * POST /api/events/:id/guests
 * Registers an individual guest.
 */
router.post('/events/:id/guests', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = req.eventAccess!.eventId;
    const guest = await guestService.createGuest(eventId, req.user!.id, req.body, getIp(req));

    res.status(201).json({
      success: true,
      message: 'Convidado cadastrado com sucesso.',
      data: guest,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/events/:id/guests/import
 * Imports guests from a CSV or XLSX spreadsheet.
 */
router.post(
  '/events/:id/guests/import',
  authenticateToken,
  requireEventAdmin,
  uploadDoc.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ success: false, error: 'Selecione um arquivo CSV ou XLSX para importar.' });
        return;
      }

      const eventId = req.eventAccess!.eventId;
      const result = await guestService.importGuests(
        eventId,
        req.user!.id,
        req.file.buffer,
        req.file.originalname,
        getIp(req)
      );

      res.status(200).json({
        success: true,
        message: `Importação concluída: ${result.imported} convidados importados, ${result.duplicates} duplicados ignorados.`,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/events/:id/guests
 * Lists guests with filters, search, and pagination.
 */
router.get('/events/:id/guests', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = req.eventAccess!.eventId;
    const search = req.query.search as string;
    const category = req.query.category as string;
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 50;

    const result = await guestService.listGuests(eventId, { search, category, page, limit });

    res.status(200).json({
      success: true,
      data: result.items,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/guests/:id
 * Updates a guest.
 */
router.put('/guests/:id', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const guestId = parseId(req.params.id);
    if (guestId === null) {
      res.status(400).json({ success: false, error: 'ID de convidado inválido.' });
      return;
    }

    const [guest] = await db.select().from(eventGuests).where(eq(eventGuests.id, guestId)).limit(1);
    if (!guest) {
      res.status(404).json({ success: false, error: 'Convidado não encontrado.' });
      return;
    }

    // Owner, co-admin or platform admin of the guest's event
    if (!(await canAdminEvent(req.user, guest.eventId))) {
      res.status(403).json({ success: false, error: 'Acesso negado para gerenciar este convidado.' });
      return;
    }

    const updated = await guestService.updateGuest(guestId, req.user!.id, req.body, getIp(req));

    res.status(200).json({
      success: true,
      message: 'Convidado atualizado com sucesso.',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/events/:id/guests/:guestId
 * Deletes a guest.
 */
router.delete('/events/:id/guests/:guestId', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const guestId = parseId(req.params.guestId);
    if (guestId === null) {
      res.status(400).json({ success: false, error: 'ID de convidado inválido.' });
      return;
    }
    // Scoped to the event checked by requireEventAdmin, so guests of other events cannot be deleted
    await guestService.deleteGuest(req.eventAccess!.eventId, guestId, req.user!.id, getIp(req));

    res.status(200).json({
      success: true,
      message: 'Convidado removido com sucesso.',
    });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   3. Invitations & QR Codes
   ========================================================================== */

/**
 * POST /api/events/:id/invitations
 * Generates an invitation for a specific guest or bulk for all guests.
 */
router.post('/events/:id/invitations', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = req.eventAccess!.eventId;
    const { guestId, bulk } = req.body;

    if (bulk) {
      const result = await invitationService.generateBulkInvitations(eventId, req.user!.id, getIp(req));
      res.status(201).json({
        success: true,
        message: `${result.generated} novos convites gerados com sucesso.`,
        data: result,
      });
      return;
    }

    if (!guestId) {
      res.status(400).json({ success: false, error: 'Informe o ID do convidado para gerar o convite.' });
      return;
    }

    const invitation = await invitationService.createInvitation(eventId, Number(guestId), req.user!.id, req.body, getIp(req));

    res.status(201).json({
      success: true,
      message: 'Convite gerado com sucesso.',
      data: invitation,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/events/:id/invitations
 * Lists all invitations for an event.
 */
router.get('/events/:id/invitations', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = req.eventAccess!.eventId;

    const list = await db
      .select({
        id: eventInvitations.id,
        eventId: eventInvitations.eventId,
        guestId: eventInvitations.guestId,
        guestName: eventGuests.name,
        guestEmail: eventGuests.email,
        guestPhone: eventGuests.phone,
        guestCategory: eventGuests.category,
        tokenHash: eventInvitations.tokenHash,
        status: eventInvitations.status,
        maxEntries: eventInvitations.maxEntries,
        usedEntries: eventInvitations.usedEntries,
        validFrom: eventInvitations.validFrom,
        validUntil: eventInvitations.validUntil,
        issuedAt: eventInvitations.issuedAt,
        revokedAt: eventInvitations.revokedAt,
      })
      .from(eventInvitations)
      .innerJoin(eventGuests, eq(eventInvitations.guestId, eventGuests.id))
      .where(eq(eventInvitations.eventId, eventId))
      .orderBy(desc(eventInvitations.createdAt));

    res.status(200).json({
      success: true,
      data: list,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/invitations/:id/revoke
 * Revokes / cancels an invitation.
 */
router.post('/invitations/:id/revoke', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invitationId = parseId(req.params.id);
    if (invitationId === null) {
      res.status(400).json({ success: false, error: 'ID de convite inválido.' });
      return;
    }
    const [invitation] = await db.select().from(eventInvitations).where(eq(eventInvitations.id, invitationId)).limit(1);
    if (!invitation) {
      res.status(404).json({ success: false, error: 'Convite não encontrado.' });
      return;
    }

    if (!(await canAdminEvent(req.user, invitation.eventId))) {
      res.status(403).json({ success: false, error: 'Acesso negado para cancelar este convite.' });
      return;
    }

    const revoked = await invitationService.revokeInvitation(invitationId, req.user!.id, getIp(req));

    res.status(200).json({
      success: true,
      message: 'Convite cancelado com sucesso.',
      data: revoked,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/invitations/:id/resend
 * Cancels old invitation and reissues a new one with a fresh token.
 */
router.post('/invitations/:id/resend', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invitationId = parseId(req.params.id);
    if (invitationId === null) {
      res.status(400).json({ success: false, error: 'ID de convite inválido.' });
      return;
    }
    const [invitation] = await db.select().from(eventInvitations).where(eq(eventInvitations.id, invitationId)).limit(1);
    if (!invitation) {
      res.status(404).json({ success: false, error: 'Convite não encontrado.' });
      return;
    }

    if (!(await canAdminEvent(req.user, invitation.eventId))) {
      res.status(403).json({ success: false, error: 'Acesso negado para reemitir este convite.' });
      return;
    }

    const reissued = await invitationService.reissueInvitation(invitationId, req.user!.id, getIp(req));

    res.status(200).json({
      success: true,
      message: 'Novo convite reemitido com sucesso.',
      data: reissued,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/invitations/:id/pdf
 * Generates and downloads invitation in PDF (event admins only: the PDF carries the entry QR code,
 * and invitation ids are sequential, so it must never be served by id to anonymous users).
 */
router.get('/invitations/:id/pdf', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invitationId = parseId(req.params.id);
    if (invitationId === null) {
      res.status(400).json({ success: false, error: 'ID de convite inválido.' });
      return;
    }

    const [invitation] = await db
      .select({ eventId: eventInvitations.eventId })
      .from(eventInvitations)
      .where(eq(eventInvitations.id, invitationId))
      .limit(1);
    if (!invitation) {
      res.status(404).json({ success: false, error: 'Convite não encontrado.' });
      return;
    }
    if (!(await canAdminEvent(req.user, invitation.eventId))) {
      res.status(403).json({ success: false, error: 'Acesso negado para baixar este convite.' });
      return;
    }

    const pdfBuffer = await invitationService.generatePDF(invitationId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="convite-${invitationId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/invitations/public/:token/pdf
 * Public PDF download for the holder of the invitation link.
 */
router.get('/invitations/public/:token/pdf', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invitationId = await invitationService.findInvitationIdByToken(req.params.token as string);
    if (!invitationId) {
      res.status(404).json({ success: false, error: 'Convite não encontrado ou inválido.' });
      return;
    }

    const pdfBuffer = await invitationService.generatePDF(invitationId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="convite-${invitationId}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/invitations/public/:token
 * Public endpoint to view a digital invitation by token or tokenHash.
 */
router.get('/invitations/public/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.params.token as string;
    const data = await invitationService.getPublicInvitation(token);

    if (!data) {
      res.status(404).json({ success: false, error: 'Convite não encontrado ou inválido.' });
      return;
    }

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   4. Deliveries (Email and WhatsApp)
   ========================================================================== */

/**
 * GET /api/events/:id/deliveries/config
 * Returns delivery providers status (SMTP and WhatsApp Cloud API).
 */
router.get('/events/:id/deliveries/config', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = deliveryService.getDeliveryConfig();
    res.status(200).json({
      success: true,
      data: config,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/invitations/:id/mark-sent
 * Records a direct/client delivery (WhatsApp Web or local email client) and updates status.
 */
router.post('/invitations/:id/mark-sent', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invitationId = parseId(req.params.id);
    if (invitationId === null) {
      res.status(400).json({ success: false, error: 'ID de convite inválido.' });
      return;
    }
    const { channel, destination } = req.body || {};

    if (!channel || !['whatsapp', 'email'].includes(channel)) {
      res.status(400).json({ success: false, error: 'Canal inválido (deve ser whatsapp ou email).' });
      return;
    }

    const [invitation] = await db.select().from(eventInvitations).where(eq(eventInvitations.id, invitationId)).limit(1);
    if (!invitation) {
      res.status(404).json({ success: false, error: 'Convite não encontrado.' });
      return;
    }

    if (!(await canAdminEvent(req.user, invitation.eventId))) {
      res.status(403).json({ success: false, error: 'Acesso negado para gerenciar este convite.' });
      return;
    }

    await deliveryService.markAsSent(invitationId, channel, destination, req.user!.id, getIp(req));

    res.status(200).json({
      success: true,
      message: 'Status de envio registrado com sucesso.',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/events/:id/deliveries/email
 * Dispatches invitation emails individually or in batch.
 */
router.post('/events/:id/deliveries/email', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = req.eventAccess!.eventId;
    const { invitationIds, attachPdf } = req.body ?? {};

    const result = await deliveryService.dispatchBatch(
      eventId,
      req.user!.id,
      'email',
      parseIdList(invitationIds),
      Boolean(attachPdf),
      getIp(req)
    );

    if (result.sent === 0 && result.failed > 0) {
      res.status(400).json({
        success: false,
        error: result.details[0]?.error || 'Falha no disparo de e-mails.',
        data: result,
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: `Disparo de e-mails concluído: ${result.sent} enviados, ${result.failed} falhas.`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/events/:id/deliveries/whatsapp
 * Dispatches invitation WhatsApp messages individually or in batch.
 */
router.post('/events/:id/deliveries/whatsapp', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = req.eventAccess!.eventId;
    const { invitationIds } = req.body ?? {};

    const result = await deliveryService.dispatchBatch(
      eventId,
      req.user!.id,
      'whatsapp',
      parseIdList(invitationIds),
      false,
      getIp(req)
    );

    if (result.sent === 0 && result.failed > 0) {
      res.status(400).json({
        success: false,
        error: result.details[0]?.error || 'Falha no disparo de WhatsApp.',
        data: result,
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: `Disparo de WhatsApp concluído: ${result.sent} enviados, ${result.failed} falhas.`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   5. Readers Management
   ========================================================================== */

/**
 * POST /api/events/:id/readers
 * Adds an authorized reader to an event.
 */
router.post('/events/:id/readers', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = req.eventAccess!.eventId;
    const { userEmail, userId } = req.body;

    const target = userEmail || userId;
    if (!target) {
      res.status(400).json({ success: false, error: 'Informe o e-mail ou ID do usuário leitor.' });
      return;
    }

    const reader = await checkinService.addReader(eventId, target, req.user!.id, getIp(req));

    res.status(201).json({
      success: true,
      message: 'Leitor autorizado com sucesso para este evento.',
      data: reader,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/events/:id/readers/:userId
 * Deauthorizes a reader from an event.
 */
router.delete('/events/:id/readers/:userId', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = req.eventAccess!.eventId;
    const readerUserId = parseId(req.params.userId);
    if (readerUserId === null) {
      res.status(400).json({ success: false, error: 'ID de usuário inválido.' });
      return;
    }

    await checkinService.removeReader(eventId, readerUserId, req.user!.id, getIp(req));

    res.status(200).json({
      success: true,
      message: 'Permissão de leitor removida com sucesso.',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/events/:id/readers
 * Lists authorized readers for an event.
 */
router.get('/events/:id/readers', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = req.eventAccess!.eventId;
    const list = await checkinService.listReaders(eventId);

    res.status(200).json({
      success: true,
      data: list,
    });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   6. Check-in & Real-time Validation (Atomic)
   ========================================================================== */

/**
 * POST /api/checkin/validate
 * Validates a QR code and registers check-in atomically.
 */
router.post('/checkin/validate', authenticateToken, requireEventReader, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = req.eventAccess!.eventId;
    const { token, qrCode, deviceIdentifier } = req.body;

    const tokenTarget = token || qrCode;
    if (!tokenTarget) {
      res.status(400).json({
        success: false,
        status: 'INVALIDO',
        color: 'vermelho',
        message: 'Código de QR Code ausente na requisição.',
      });
      return;
    }

    // Extract token if user sent full URL e.g. "https://.../convite/<token>"
    const cleanToken = String(tokenTarget).split('/convite/').pop()?.split('?')[0] || String(tokenTarget);

    const result = await checkinService.validateAndCheckin(
      eventId,
      cleanToken,
      req.user!.id,
      deviceIdentifier,
      getIp(req)
    );

    res.status(200).json({
      success: result.allowed,
      ...result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/events/:id/checkins
 * Lists entry check-in records for an event.
 */
router.get('/events/:id/checkins', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = req.eventAccess!.eventId;

    const list = await db
      .select({
        id: eventCheckins.id,
        eventId: eventCheckins.eventId,
        invitationId: eventCheckins.invitationId,
        guestId: eventCheckins.guestId,
        guestName: eventGuests.name,
        guestCategory: eventGuests.category,
        readerName: users.name,
        deviceIdentifier: eventCheckins.deviceIdentifier,
        checkedInAt: eventCheckins.checkedInAt,
        result: eventCheckins.result,
      })
      .from(eventCheckins)
      .innerJoin(eventGuests, eq(eventCheckins.guestId, eventGuests.id))
      .leftJoin(users, eq(eventCheckins.readerUserId, users.id))
      .where(eq(eventCheckins.eventId, eventId))
      .orderBy(desc(eventCheckins.checkedInAt));

    res.status(200).json({
      success: true,
      data: list,
    });
  } catch (error) {
    next(error);
  }
});

/* ==========================================================================
   7. Dashboard Metrics, Reports & Audit
   ========================================================================== */

/**
 * GET /api/events/:id/dashboard
 * Real-time event indicators.
 */
router.get('/events/:id/dashboard', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = req.eventAccess!.eventId;
    const metrics = await reportService.getDashboardMetrics(eventId);

    res.status(200).json({
      success: true,
      data: metrics,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/events/:id/reports
 * Downloads report in XLSX or CSV.
 */
router.get('/events/:id/reports', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = req.eventAccess!.eventId;
    const type = (req.query.type as string) || 'guests';
    const format = (req.query.format as string) || 'xlsx';
    if (!(REPORT_TYPES as readonly string[]).includes(type) || !(REPORT_FORMATS as readonly string[]).includes(format)) {
      res.status(400).json({ success: false, error: 'Tipo ou formato de relatório inválido.' });
      return;
    }

    const buffer = await reportService.exportReport(
      eventId,
      type as (typeof REPORT_TYPES)[number],
      format as (typeof REPORT_FORMATS)[number]
    );

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="relatorio-${type}-${eventId}.csv"`);
    } else {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="relatorio-${type}-${eventId}.xlsx"`);
    }

    res.send(buffer);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/events/:id/audit-logs
 * Retrieves audit trail.
 */
router.get('/events/:id/audit-logs', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = req.eventAccess!.eventId;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit as string, 10) || 100));
    const logs = await getEventAuditLogs(eventId, limit);

    res.status(200).json({
      success: true,
      data: logs,
    });
  } catch (error) {
    next(error);
  }
});

export default router;

