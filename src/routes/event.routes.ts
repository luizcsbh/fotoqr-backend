import { Router, Request, Response, NextFunction } from 'express';
import { eventService } from '../services/event.service.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';

const router = Router();

/**
 * POST /api/events
 * Creates a new event for the authenticated user.
 */
router.post('/', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const event = await eventService.createEvent(userId, req.body);

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
 * Lists all events owned by the authenticated user.
 */
router.get('/', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const events = await eventService.getUserEvents(userId);

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
    const event = await eventService.getEventByIdOrUuid(idOrUuid, req.user?.id);

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
        storageMode: event.storageMode,
        isActive: event.isActive,
        enableDjPlaylist: event.enableDjPlaylist,
        requirePhotoApproval: event.requirePhotoApproval,
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
    const updatedEvent = await eventService.toggleEventActive(eventId, userId);

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
    const updatedEvent = await eventService.setDjPlaylistEnabled(eventId, userId, enabled);

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
    const event = await eventService.getEventByIdOrUuid(req.params.id as string, userId);
    if (!event || event.userId !== userId) {
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
    const event = await eventService.getEventByIdOrUuid(req.params.id as string, userId);
    if (!event || event.userId !== userId) {
      res.status(404).json({ success: false, error: 'Evento não encontrado.' });
      return;
    }

    const saved = await eventService.saveQRCustomization(event.id, userId, req.body);
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
    const updatedEvent = await eventService.setPhotoApprovalRequired(eventId, userId, enabled);

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
    await eventService.deleteEvent(eventId, userId);

    res.status(200).json({
      success: true,
      message: 'Evento excluído com sucesso.',
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
    const stats = await eventService.getEventStats(eventId, userId);

    res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
