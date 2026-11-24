import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { events, photos } from '../models/schema.js';
import { photoService, UploadResult } from '../services/photo.service.js';
import { galleryService } from '../services/gallery.service.js';
import { eventService } from '../services/event.service.js';
import { localStorageService } from '../services/local.storage.service.js';
import { uploadMiddleware } from '../middleware/upload.js';
import { galleryLimiter, uploadLimiter } from '../middleware/rateLimiter.js';
import { messageWallService } from '../services/messageWall.service.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';
import { isSuperOrPlatformAdmin } from '../middleware/rbac.js';
import { logger } from '../utils/logger.js';
import { moderateImage, ModerationResult } from '../services/moderation.service.js';
import { isValidPhotoKey } from '../utils/photoAccess.js';
import { auditContext, recordAudit } from '../services/audit.service.js';

const router = Router();

/**
 * POST /api/events/:uuid/photos
 * Public photo upload endpoint. Anyone scanning the QR code can upload photos without login.
 */
router.post(
  '/events/:uuid/photos',
  uploadLimiter,
  uploadMiddleware.any(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uuid = req.params.uuid as string;
      const files = req.files as Express.Multer.File[];

      if (!files || files.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Nenhuma foto foi selecionada para envio.',
        });
        return;
      }

      // Find event by UUID
      const event = await eventService.getEventByUuid(uuid);
      if (!event) {
        res.status(404).json({
          success: false,
          error: 'Evento não encontrado.',
        });
        return;
      }

      if (!event.isActive) {
        res.status(403).json({
          success: false,
          error: 'Este álbum está temporariamente pausado e não está aceitando novos envios.',
        });
        return;
      }

      // Automatic moderation (4 photos at a time): almost-certainly inappropriate photos are discarded,
      // photos flagged by the provider or that it could not check go to the owner's review queue
      const reviewReasons = new Map<Express.Multer.File, string>();
      const rejected: UploadResult[] = [];
      const accepted: Express.Multer.File[] = [];
      const verdicts = new Map<Express.Multer.File, ModerationResult>();
      const MODERATION_CONCURRENCY = 4;

      for (let i = 0; i < files.length; i += MODERATION_CONCURRENCY) {
        await Promise.all(
          files.slice(i, i + MODERATION_CONCURRENCY).map(async (file) => {
            // Use file.buffer if available (memory storage), or read from disk
            const buffer =
              file.buffer && file.buffer.length > 0 ? file.buffer : file.path ? fs.readFileSync(file.path) : null;
            if (buffer) verdicts.set(file, await moderateImage(buffer, file.mimetype));
          })
        );
      }

      for (const file of files) {
        const modResult = verdicts.get(file);
        if (modResult?.outcome === 'rejected') {
          logger.warn(`[moderation] Photo "${file.originalname}" rejected automatically: ${modResult.reason}`);
          rejected.push({
            originalFilename: Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 255),
            storedFilename: '',
            storageProvider: 'database',
            storagePath: '',
            fileSize: file.size,
            status: 'failed',
            error: 'Esta foto foi recusada pela moderação automática por conter conteúdo impróprio.',
          });
          continue;
        }
        if (modResult?.outcome === 'flagged' || modResult?.outcome === 'failed') {
          logger.warn(`[moderation] Photo "${file.originalname}" sent to manual review: ${modResult.reason}`);
          reviewReasons.set(file, modResult.reason ?? 'Revisão manual necessária');
        }
        accepted.push(file);
      }

      const results = [
        ...(await photoService.processAndUpload(accepted, event.id, event.storageMode, reviewReasons)),
        ...rejected,
      ];
      const successCount = results.filter((r) => r.status === 'success').length;
      const duplicateCount = results.filter((r) => r.status === 'duplicate').length;
      const failCount = results.filter((r) => r.status === 'failed').length;

      let message = `${successCount} fotos enviadas com sucesso!`;
      if (duplicateCount > 0) message += ` (${duplicateCount} duplicadas ignoradas)`;
      if (rejected.length > 0) message += ` ${rejected.length} foto(s) recusada(s) pela moderação automática.`;
      const pendingCount = results.filter((r) => r.status === 'success' && r.pendingApproval).length;
      if (pendingCount > 0) {
        message += ' As fotos aparecem na galeria depois da aprovação do anfitrião.';
      }

      res.status(200).json({
        success: true,
        message,
        summary: {
          total: files.length,
          success: successCount,
          duplicate: duplicateCount,
          failed: failCount,
          pendingApproval: pendingCount,
        },
        results,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/events/:idOrUuid/photos
 * Returns paginated photos for an event (accepts ID or UUID).
 */
router.get('/events/:idOrUuid/photos', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idOrUuid = req.params.idOrUuid as string;
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;

    const event = await eventService.getEventByIdOrUuid(idOrUuid, req.user?.id, req.user?.role, req.user?.email);
    if (!event) {
      res.status(404).json({
        success: false,
        error: 'Evento não encontrado.',
      });
      return;
    }

    // ?review=pending lists the photos waiting for approval — only the event owner or super admin may see them
    const reviewStatus = req.query.review === 'pending' ? 'pending' : 'approved';
    const isSuper = isSuperOrPlatformAdmin(req.user?.role, req.user?.email);
    if (reviewStatus === 'pending' && event.userId !== req.user?.id && !isSuper) {
      res.status(403).json({ success: false, error: 'Apenas o dono do evento pode ver fotos pendentes.' });
      return;
    }

    const galleryData = await galleryService.getEventPhotos(event.id, page, limit, reviewStatus);

    const formattedPhotos = galleryData.photos.map((p) => ({
      id: String(p.id),
      event_id: String(p.eventId),
      filename: p.storedFilename,
      original_name: p.originalFilename,
      url: p.url,
      thumbnail_url: p.thumbnail_url || p.url,
      size: p.fileSize,
      mime_type: p.mimeType,
      storage_provider: p.storageProvider,
      review_status: p.reviewStatus,
      // Moderation details are only for the owner's review queue
      ...(reviewStatus === 'pending' && { review_reason: p.reviewReason }),
      uploaded_at: p.uploadedAt ? p.uploadedAt.toISOString() : new Date().toISOString(),
    }));

    res.status(200).json({
      success: true,
      data: formattedPhotos,
      total: galleryData.pagination.total,
      page: galleryData.pagination.page,
      limit: galleryData.pagination.limit,
      total_pages: galleryData.pagination.totalPages,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/events/:uuid/gallery
 * Public paginated gallery of photos uploaded to the event.
 */
router.get('/events/:uuid/gallery', galleryLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uuid = req.params.uuid as string;
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 24;

    const event = await eventService.getEventByUuid(uuid);
    if (!event) {
      res.status(404).json({
        success: false,
        error: 'Evento não encontrado.',
      });
      return;
    }

    const galleryData = await galleryService.getEventPhotos(event.id, page, limit);
    // ?messages=1 (Telão): the wall messages come in the same refresh, so it polls a single endpoint
    const withMessages = req.query.messages === '1' && event.enableMessageWall;
    const messages = withMessages ? await messageWallService.listPublic(event.id) : [];

    const formattedPhotos = galleryData.photos.map((p) => ({
      id: String(p.id),
      event_id: String(p.eventId),
      filename: p.storedFilename,
      original_name: p.originalFilename,
      url: p.url,
      thumbnail_url: p.thumbnail_url || p.url,
      size: p.fileSize,
      mime_type: p.mimeType,
      storage_provider: p.storageProvider,
      uploaded_at: p.uploadedAt ? p.uploadedAt.toISOString() : new Date().toISOString(),
    }));

    res.status(200).json({
      success: true,
      data: {
        event: {
          uuid: event.uuid,
          title: event.title,
          description: event.description,
          eventDate: event.eventDate,
          startDate: event.startDate,
          endDate: event.endDate,
          isActive: event.isActive,
          photoCount: event.photoCount,
          enableMessageWall: event.enableMessageWall,
        },
        photos: formattedPhotos,
        messages,
        total: galleryData.pagination.total,
        page: galleryData.pagination.page,
        limit: galleryData.pagination.limit,
        totalPages: galleryData.pagination.totalPages,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Handler for streaming ZIP archive containing all or selected photos.
 * Accessible via both /events/:idOrUuid/download and /events/:idOrUuid/photos/download.
 */
const handleZipDownload = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idOrUuid = (req.params.idOrUuid || req.params.id) as string;
    const event = await eventService.getEventByIdOrUuid(idOrUuid, req.user?.id, req.user?.role, req.user?.email);
    if (!event) {
      res.status(404).json({
        success: false,
        error: 'Evento não encontrado.',
      });
      return;
    }

    const rawIds = (req.query.photoIds || req.query.ids) as string;
    const photoIds = rawIds
      ? rawIds
          .split(',')
          .map((x) => parseInt(x.trim(), 10))
          .filter((n) => !isNaN(n))
      : undefined;

    const sanitizedTitle = event.title.replace(/[^a-zA-Z0-9_\u00C0-\u00FF-]/g, '_');
    const suffix = photoIds && photoIds.length > 0 ? `_selecionadas_${photoIds.length}` : '_todas';
    const filename = `fotoqr_${sanitizedTitle}${suffix}.zip`;

    const archive = await galleryService.generateZipDownload(event.id, photoIds);

    // Headers are only set once the archive exists, so earlier failures still reach the JSON error handler
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    archive.on('error', (err) => {
      logger.error('Erro durante o streaming do arquivo ZIP:', err);
      res.destroy(err);
    });
    // Stop compressing if the client gives up on the download
    res.on('close', () => {
      if (!res.writableFinished) archive.abort();
    });
    archive.pipe(res);
  } catch (error) {
    next(error);
  }
};

router.get('/events/:idOrUuid/download', optionalAuth, handleZipDownload);
router.get('/events/:id/photos/download', authenticateToken, handleZipDownload);

/**
 * Photos waiting for approval are only served to the owner of their event.
 * Returns the Cache-Control to use, or null when the request must be refused.
 */
async function resolvePhotoAccess(
  photo: { reviewStatus: 'approved' | 'pending'; eventId: number },
  req: Request
): Promise<string | null> {
  // Approved photos: anyone holding the signed URL from the gallery (k = per-photo key).
  // Guessing sequential ids without the key no longer reveals other events' photos.
  if (photo.reviewStatus === 'approved' && isValidPhotoKey(req.params.id as string, req.query.k)) {
    return 'public, max-age=31536000, immutable';
  }
  if (!req.user) return null;

  const [owner] = await db
    .select({ userId: events.userId })
    .from(events)
    .where(eq(events.id, photo.eventId))
    .limit(1);

  // The owner always has access; never let shared caches keep these responses
  return owner?.userId === req.user.id ? 'private, no-store' : null;
}

/**
 * GET /api/photos/:id/file
 * GET /api/photos/:id
 * Streams the photo image binary directly from the database.
 */
router.get(['/photos/:id/file', '/photos/:id'], optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const photoId = parseInt(req.params.id as string, 10);
    if (isNaN(photoId)) {
      res.status(400).json({ success: false, error: 'ID da foto inválido.' });
      return;
    }

    const [photo] = await db
      .select({
        mimeType: photos.mimeType,
        fileData: photos.fileData,
        storedFilename: photos.storedFilename,
        originalFilename: photos.originalFilename,
        storagePath: photos.storagePath,
        storageProvider: photos.storageProvider,
        reviewStatus: photos.reviewStatus,
        eventId: photos.eventId,
      })
      .from(photos)
      .where(eq(photos.id, photoId))
      .limit(1);

    const cacheControl = photo ? await resolvePhotoAccess(photo, req) : null;
    if (!photo || !cacheControl) {
      res.status(404).json({ success: false, error: 'Foto não encontrada.' });
      return;
    }

    if (photo.fileData) {
      res.setHeader('Content-Type', photo.mimeType || 'image/jpeg');
      res.setHeader('Content-Length', photo.fileData.length);
      res.setHeader('Cache-Control', cacheControl);
      res.setHeader('Content-Disposition', `inline; filename="${photo.storedFilename}"`);
      res.end(photo.fileData);
      return;
    }

    // Fallback if legacy photo stored locally on disk
    if (photo.storagePath && photo.storagePath !== 'database') {
      const fullPath = path.resolve(process.cwd(), 'uploads', photo.storagePath);
      if (fs.existsSync(fullPath)) {
        res.sendFile(fullPath);
        return;
      }
    }

    res.status(404).json({ success: false, error: 'Arquivo da foto não encontrado.' });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/photos/:id/thumbnail
 * Streams the thumbnail binary directly from the database.
 */
router.get('/photos/:id/thumbnail', optionalAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const photoId = parseInt(req.params.id as string, 10);
    if (isNaN(photoId)) {
      res.status(400).json({ success: false, error: 'ID da foto inválido.' });
      return;
    }

    const [photo] = await db
      .select({
        mimeType: photos.mimeType,
        thumbnailData: photos.thumbnailData,
        fileData: photos.fileData,
        storedFilename: photos.storedFilename,
        storagePath: photos.storagePath,
        reviewStatus: photos.reviewStatus,
        eventId: photos.eventId,
      })
      .from(photos)
      .where(eq(photos.id, photoId))
      .limit(1);

    const cacheControl = photo ? await resolvePhotoAccess(photo, req) : null;
    if (!photo || !cacheControl) {
      res.status(404).json({ success: false, error: 'Foto não encontrada.' });
      return;
    }

    const buffer = photo.thumbnailData || photo.fileData;
    if (buffer) {
      res.setHeader('Content-Type', photo.mimeType || 'image/jpeg');
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Cache-Control', cacheControl);
      res.setHeader('Content-Disposition', `inline; filename="thumb_${photo.storedFilename}"`);
      res.end(buffer);
      return;
    }

    // Fallback if legacy photo stored locally on disk
    if (photo.storagePath && photo.storagePath !== 'database') {
      const fullPath = path.resolve(process.cwd(), 'uploads', photo.storagePath);
      if (fs.existsSync(fullPath)) {
        res.sendFile(fullPath);
        return;
      }
    }

    res.status(404).json({ success: false, error: 'Miniatura da foto não encontrada.' });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/photos/:id
 * Deletes a specific photo (event owner authentication required).
 */
router.delete('/photos/:id', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const photoId = parseInt(id, 10);
    if (isNaN(photoId)) {
      res.status(400).json({
        success: false,
        error: 'ID da foto inválido.',
      });
      return;
    }

    const userId = req.user!.id;
    const isSuper = isSuperOrPlatformAdmin(req.user?.role, req.user?.email);

    // Join with events to ensure the authenticated user owns the event (or is super admin)
    const [result] = await db
      .select({
        photo: photos,
        event: events,
      })
      .from(photos)
      .innerJoin(events, eq(photos.eventId, events.id))
      .where(isSuper ? eq(photos.id, photoId) : and(eq(photos.id, photoId), eq(events.userId, userId)))
      .limit(1);

    if (!result) {
      res.status(404).json({
        success: false,
        error: 'Foto não encontrada ou você não tem permissão para excluí-la.',
      });
      return;
    }

    // Attempt storage deletion
    if (result.photo.storageProvider === 'local' || result.photo.storageProvider === 'supabase') {
      await localStorageService.deletePhoto(result.photo.storagePath);
    }

    // Delete photo record from database
    await db.delete(photos).where(eq(photos.id, photoId));

    // Decrement event photo_count (pending photos were never counted)
    if (result.photo.reviewStatus === 'approved') {
      await db
        .update(events)
        .set({
          photoCount: sql`GREATEST(0, ${events.photoCount} - 1)`,
          updatedAt: new Date(),
        })
        .where(eq(events.id, result.event.id));
    }

    await recordAudit({
      ...auditContext(req),
      action: 'PHOTO_DELETE',
      entityType: 'photo',
      entityId: photoId,
      eventId: result.event.id,
      eventTitle: result.event.title,
      description: `Foto "${result.photo.originalFilename}" excluída`,
      metadata: { reviewStatus: result.photo.reviewStatus },
    });

    res.status(200).json({
      success: true,
      message: 'Foto excluída com sucesso.',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/photos/:id/approve
 * Publishes a photo that is waiting for review (event owner only).
 */
router.post('/photos/:id/approve', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const photoId = parseInt(req.params.id as string, 10);
    if (isNaN(photoId)) {
      res.status(400).json({ success: false, error: 'ID da foto inválido.' });
      return;
    }

    const isSuper = isSuperOrPlatformAdmin(req.user?.role, req.user?.email);
    const [result] = await db
      .select({ eventId: photos.eventId, eventTitle: events.title })
      .from(photos)
      .innerJoin(events, eq(photos.eventId, events.id))
      .where(isSuper ? eq(photos.id, photoId) : and(eq(photos.id, photoId), eq(events.userId, req.user!.id)))
      .limit(1);

    if (!result) {
      res.status(404).json({
        success: false,
        error: 'Foto não encontrada ou você não tem permissão para aprová-la.',
      });
      return;
    }

    const approved = await photoService.approvePhotos(result.eventId, [photoId]);
    if (approved > 0) {
      await recordAudit({
        ...auditContext(req),
        action: 'PHOTO_APPROVE',
        entityType: 'photo',
        entityId: photoId,
        eventId: result.eventId,
        eventTitle: result.eventTitle,
        description: 'Foto aprovada e publicada na galeria',
      });
    }
    res.status(200).json({
      success: true,
      approved,
      message: approved > 0 ? 'Foto aprovada e publicada na galeria.' : 'Esta foto já estava aprovada.',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/events/:id/photos/approve
 * Publishes every photo of the event that is waiting for review (event owner or super admin).
 * Body: { photoIds?: number[] } — limits the approval to those photos.
 */
router.post('/events/:id/photos/approve', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isSuper = isSuperOrPlatformAdmin(req.user?.role, req.user?.email);
    const event = await eventService.getEventByIdOrUuid(req.params.id as string, req.user!.id, req.user?.role, req.user?.email);
    if (!event || (event.userId !== req.user!.id && !isSuper)) {
      res.status(404).json({ success: false, error: 'Evento não encontrado.' });
      return;
    }

    const rawIds = req.body?.photoIds;
    const photoIds = Array.isArray(rawIds)
      ? rawIds.map((x: unknown) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
      : undefined;

    const approved = await photoService.approvePhotos(event.id, photoIds);
    if (approved > 0) {
      await recordAudit({
        ...auditContext(req),
        action: 'PHOTO_APPROVE_BULK',
        entityType: 'photo',
        eventId: event.id,
        eventTitle: event.title,
        description: `${approved} foto(s) aprovada(s) de uma vez`,
        metadata: { approved },
      });
    }
    res.status(200).json({
      success: true,
      approved,
      message: approved > 0 ? `${approved} foto(s) aprovada(s) e publicada(s) na galeria.` : 'Nenhuma foto pendente.',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
