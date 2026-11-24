import { Router, Request, Response, NextFunction } from 'express';
import { eventService } from '../services/event.service.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { isSuperOrPlatformAdmin } from '../middleware/rbac.js';
import { auditContext, recordAudit } from '../services/audit.service.js';

const router = Router();

/**
 * POST /api/events
 * Creates a new event for the authenticated user.
 */
router.post('/', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const event = await eventService.createEvent(userId, req.body);
    await recordAudit({
      ...auditContext(req),
      action: 'EVENT_CREATE',
      entityType: 'event',
      entityId: event.id,
      eventId: event.id,
      eventTitle: event.title,
      description: `Evento "${event.title}" criado`,
    });

    res.status(201).json({
      success: true,
      message: 'Evento criado com sucesso.',
      data: event,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/events
 * Lists all events owned by the authenticated user (or all platform events if super admin).
 */
router.get('/', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const events = await eventService.getUserEvents(userId, req.user?.role, req.user?.email);

    res.status(200).json({
      success: true,
      data: events,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/events/:idOrUuid
 * Fetches event information by numeric ID or UUID.
 */
router.get('/:idOrUuid', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idOrUuid = req.params.idOrUuid as string;
    const isSuper = isSuperOrPlatformAdmin(req.user?.role, req.user?.email);
    const event = await eventService.getEventByIdOrUuid(idOrUuid, req.user?.id, req.user?.role, req.user?.email);

    if (!event) {
      res.status(404).json({
        success: false,
        error: 'Evento não encontrado.',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        id: event.id,
        uuid: event.uuid,
        userId: event.userId,
        title: event.title,
        description: event.description,
        eventDate: event.eventDate,
        startDate: event.startDate,
        endDate: event.endDate,
        category: event.category,
        startAt: event.startAt,
        endAt: event.endAt,
        location: event.location,
        capacity: event.capacity,
        status: event.status,
        maxEntriesPerInvitation: event.maxEntriesPerInvitation,
        // Images can be large data: URLs, so they are only sent to the owner (cover editor) or super admin
        ...((req.user?.id === event.userId || isSuper) && {
          coverImage: event.coverImage,
          backgroundImage: event.backgroundImage,
        }),
        invitationTemplate: event.invitationTemplate,
        storageMode: event.storageMode,
        isActive: event.isActive,
        enableDjPlaylist: event.enableDjPlaylist,
        requirePhotoApproval: event.requirePhotoApproval,
        enableMessageWall: event.enableMessageWall,
        photoCount: event.photoCount,
        publicUrl: event.publicUrl,
        qrCodeUrl: event.qrCodeUrl,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/events/:id
 * Updates an event's details while strictly preserving its UUID and QR Code.
 */
router.put('/:id', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawId = req.params.id as string;
    const userId = req.user!.id;
    const updated = await eventService.updateEvent(rawId, userId, req.body, req.user?.role, req.user?.email);
    await recordAudit({
      ...auditContext(req),
      action: 'EVENT_UPDATE',
      entityType: 'event',
      entityId: updated.id,
      eventId: updated.id,
      eventTitle: updated.title,
      description: `Evento "${updated.title}" editado`,
      metadata: { fields: Object.keys(req.body ?? {}).filter((k) => !/image/i.test(k)) },
    });

    res.status(200).json({
      success: true,
      message: 'Evento atualizado com sucesso. O QR Code permanece o mesmo.',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/events/:id/toggle
 * Toggles the event's active status (enables or pauses photo uploads).
 */
router.patch('/:id/toggle', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawId = req.params.id as string;
    let eventId: number | null = /^\d+$/.test(rawId) ? parseInt(rawId, 10) : null;

    if (!eventId) {
      const event = await eventService.getEventByUuid(rawId);
      eventId = event?.id ?? null;
    }

    if (!eventId) {
      res.status(404).json({
        success: false,
        error: 'Evento não encontrado.',
      });
      return;
    }

    const userId = req.user!.id;
    const updatedEvent = await eventService.toggleEventActive(eventId, userId, req.user?.role, req.user?.email);
    await recordAudit({
      ...auditContext(req),
      action: updatedEvent.isActive ? 'EVENT_ACTIVATE' : 'EVENT_PAUSE',
      entityType: 'event',
      entityId: updatedEvent.id,
      eventId: updatedEvent.id,
      eventTitle: updatedEvent.title,
      description: `Evento "${updatedEvent.title}" ${updatedEvent.isActive ? 'ativado' : 'pausado'}`,
    });

    res.status(200).json({
      success: true,
      message: updatedEvent.isActive ? 'Evento ativado com sucesso.' : 'Evento pausado com sucesso.',
      data: updatedEvent,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/events/:id/dj-playlist
 * Turns the guests' DJ song request playlist on or off.
 * Body: { enabled?: boolean } — toggles the current value when omitted.
 */
router.patch('/:id/dj-playlist', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawId = req.params.id as string;
    let eventId: number | null = /^\d+$/.test(rawId) ? parseInt(rawId, 10) : null;

    if (!eventId) {
      const event = await eventService.getEventByUuid(rawId);
      eventId = event?.id ?? null;
    }

    if (!eventId) {
      res.status(404).json({
        success: false,
        error: 'Evento não encontrado.',
      });
      return;
    }

    const enabled = req.body?.enabled;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, error: 'O campo "enabled" deve ser verdadeiro ou falso.' });
      return;
    }

    const userId = req.user!.id;
    const updatedEvent = await eventService.setDjPlaylistEnabled(eventId, userId, enabled, req.user?.role, req.user?.email);

    res.status(200).json({
      success: true,
      message: updatedEvent.enableDjPlaylist
        ? 'Playlist do DJ ativada. Os convidados já podem pedir músicas.'
        : 'Playlist do DJ desativada.',
      data: updatedEvent,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/events/:id/qr-customization
 * Returns the owner's saved QR code / table card design (null when never saved).
 */
router.get('/:id/qr-customization', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const isSuper = isSuperOrPlatformAdmin(req.user?.role, req.user?.email);
    const event = await eventService.getEventByIdOrUuid(req.params.id as string, userId, req.user?.role, req.user?.email);
    if (!event || (event.userId !== userId && !isSuper)) {
      res.status(404).json({ success: false, error: 'Evento não encontrado.' });
      return;
    }

    res.status(200).json({ success: true, data: event.qrCustomization ?? null });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/events/:id/qr-customization
 * Saves the owner's QR code / table card design so it is the same on every device.
 */
router.put('/:id/qr-customization', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const isSuper = isSuperOrPlatformAdmin(req.user?.role, req.user?.email);
    const event = await eventService.getEventByIdOrUuid(req.params.id as string, userId, req.user?.role, req.user?.email);
    if (!event || (event.userId !== userId && !isSuper)) {
      res.status(404).json({ success: false, error: 'Evento não encontrado.' });
      return;
    }

    const saved = await eventService.saveQRCustomization(event.id, userId, req.body, req.user?.role, req.user?.email);
    res.status(200).json({ success: true, message: 'Personalização do QR Code salva.', data: saved });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/events/:id/photo-approval
 * Turns host review of guest photos on or off: while on, new photos stay hidden
 * from the gallery until the owner approves them.
 * Body: { enabled?: boolean } — toggles the current value when omitted.
 */
router.patch('/:id/photo-approval', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawId = req.params.id as string;
    let eventId: number | null = /^\d+$/.test(rawId) ? parseInt(rawId, 10) : null;

    if (!eventId) {
      const event = await eventService.getEventByUuid(rawId);
      eventId = event?.id ?? null;
    }

    if (!eventId) {
      res.status(404).json({
        success: false,
        error: 'Evento não encontrado.',
      });
      return;
    }

    const enabled = req.body?.enabled;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, error: 'O campo "enabled" deve ser verdadeiro ou falso.' });
      return;
    }

    const userId = req.user!.id;
    const updatedEvent = await eventService.setPhotoApprovalRequired(eventId, userId, enabled, req.user?.role, req.user?.email);

    res.status(200).json({
      success: true,
      message: updatedEvent.requirePhotoApproval
        ? 'Moderação ativada. Novas fotos só aparecem na galeria depois da sua aprovação.'
        : 'Moderação desativada. Novas fotos aparecem na galeria na hora.',
      data: updatedEvent,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/events/:id
 * Deletes an event.
 */
router.delete('/:id', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawId = req.params.id as string;
    let eventId: number | null = /^\d+$/.test(rawId) ? parseInt(rawId, 10) : null;

    if (!eventId) {
      const event = await eventService.getEventByUuid(rawId);
      eventId = event?.id ?? null;
    }

    if (!eventId) {
      res.status(404).json({
        success: false,
        error: 'Evento não encontrado.',
      });
      return;
    }

    const userId = req.user!.id;
    const { event, photosDeleted } = await eventService.deleteEvent(eventId, userId, req.user?.role, req.user?.email);
    await recordAudit({
      ...auditContext(req),
      action: 'EVENT_DELETE',
      entityType: 'event',
      entityId: event.id,
      eventId: event.id,
      eventTitle: event.title,
      description: `Evento "${event.title}" excluído com ${photosDeleted} foto(s)`,
      metadata: { photosDeleted, ownerUserId: event.userId, uuid: event.uuid },
    });

    res.status(200).json({
      success: true,
      message:
        photosDeleted > 0
          ? `Evento excluído com sucesso. ${photosDeleted} foto(s) removida(s).`
          : 'Evento excluído com sucesso.',
      photosDeleted,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/events/:id/stats
 * Retrieves stats for an event (auth required).
 */
router.get('/:id/stats', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawId = req.params.id as string;
    let eventId: number | null = /^\d+$/.test(rawId) ? parseInt(rawId, 10) : null;

    if (!eventId) {
      const event = await eventService.getEventByUuid(rawId);
      eventId = event?.id ?? null;
    }

    if (!eventId) {
      res.status(404).json({
        success: false,
        error: 'Evento não encontrado.',
      });
      return;
    }

    const userId = req.user!.id;
    const stats = await eventService.getEventStats(eventId, userId, req.user?.role, req.user?.email);

    res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
