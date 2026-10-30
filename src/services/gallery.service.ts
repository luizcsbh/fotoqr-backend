import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { db } from '../config/database.js';
import { photos, events, Photo } from '../models/schema.js';
import { localStorageService } from './local.storage.service.js';
import { logger } from '../utils/logger.js';

export interface PhotoWithUrl extends Omit<Photo, 'fileData' | 'thumbnailData'> {
  url: string;
  thumbnail_url?: string;
}

export interface PaginatedPhotos {
  photos: PhotoWithUrl[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export class GalleryService {
  /**
   * Retrieves paginated photos for an event with formatted access URLs.
   */
  async getEventPhotos(
    eventId: number,
    page: number = 1,
    limit: number = 20,
    reviewStatus: 'approved' | 'pending' = 'approved'
  ): Promise<PaginatedPhotos> {
    const validPage = Math.max(1, page);
    const validLimit = Math.min(100, Math.max(1, limit));
    const offset = (validPage - 1) * validLimit;

    // Get total count
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(photos)
      .where(
        and(eq(photos.eventId, eventId), eq(photos.uploadStatus, 'success'), eq(photos.reviewStatus, reviewStatus))
      );

    const total = countResult?.count || 0;
    const totalPages = Math.ceil(total / validLimit);

    // Get metadata records (exclude heavy binary data for fast listing)
    const photoList = await db
      .select({
        id: photos.id,
        eventId: photos.eventId,
        originalFilename: photos.originalFilename,
        storedFilename: photos.storedFilename,
        storagePath: photos.storagePath,
        storageProvider: photos.storageProvider,
        mimeType: photos.mimeType,
        fileSize: photos.fileSize,
        fileHash: photos.fileHash,
        uploadedAt: photos.uploadedAt,
        uploadStatus: photos.uploadStatus,
        reviewStatus: photos.reviewStatus,
        reviewReason: photos.reviewReason,
        errorMessage: photos.errorMessage,
      })
      .from(photos)
      .where(
        and(eq(photos.eventId, eventId), eq(photos.uploadStatus, 'success'), eq(photos.reviewStatus, reviewStatus))
      )
      .orderBy(desc(photos.uploadedAt))
      .limit(validLimit)
      .offset(offset);

    // Resolve URLs pointing to database photo endpoints
    const photosWithUrl: PhotoWithUrl[] = photoList.map((photo) => {
      let url = `/api/photos/${photo.id}/file`;
      let thumbnailUrl = `/api/photos/${photo.id}/thumbnail`;

      if (photo.storageProvider === 'local' && photo.storagePath !== 'database') {
        const fullLocalPath = path.resolve(process.cwd(), 'uploads', photo.storagePath);
        if (fs.existsSync(fullLocalPath)) {
          url = localStorageService.getPhotoUrl(photo.storagePath);
          thumbnailUrl = url;
        }
      }

      return {
        ...photo,
        url,
        thumbnail_url: thumbnailUrl,
      };
    });

    return {
      photos: photosWithUrl,
      pagination: {
        page: validPage,
        limit: validLimit,
        total,
        totalPages,
      },
    };
  }

  /**
   * Generates a streaming ZIP archive containing all or selected photos of an event.
   */
  async generateZipDownload(eventId: number, photoIds?: number[]): Promise<archiver.Archiver> {
    const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!event) {
      throw new Error('Evento não encontrado para geração de download.');
    }

    // Photos waiting for host review are never included in downloads
    let filterCondition = and(
      eq(photos.eventId, eventId),
      eq(photos.uploadStatus, 'success'),
      eq(photos.reviewStatus, 'approved')
    );
    if (photoIds && photoIds.length > 0) {
      filterCondition = and(filterCondition, inArray(photos.id, photoIds));
    }

    const eventPhotos = await db
      .select({
        id: photos.id,
        originalFilename: photos.originalFilename,
        storedFilename: photos.storedFilename,
        storagePath: photos.storagePath,
        storageProvider: photos.storageProvider,
        fileData: photos.fileData,
      })
      .from(photos)
      .where(filterCondition);

    const archive = archiver('zip', {
      zlib: { level: 6 },
    });

    archive.on('warning', (err) => {
      logger.warn('Aviso no empacotamento ZIP:', err);
    });

    // Throwing inside an emitter listener would crash the process; the route listens for
    // 'error' and closes the response instead.
    archive.on('error', (err) => {
      logger.error('Erro na geração do arquivo ZIP:', err);
    });

    // Populate the archive asynchronously
    (async () => {
      try {
        const usedNames = new Set<string>();

        for (let i = 0; i < eventPhotos.length; i++) {
          const photo = eventPhotos[i];
          let fileName = photo.originalFilename || `foto_${i + 1}.jpg`;

          // Handle duplicate file names in archive
          if (usedNames.has(fileName)) {
            const ext = path.extname(fileName);
            const base = path.basename(fileName, ext);
            fileName = `${base}_${i + 1}${ext}`;
          }
          usedNames.add(fileName);

          if (photo.fileData) {
            archive.append(photo.fileData, { name: fileName });
          } else if (photo.storagePath) {
            const fullLocalPath = path.resolve(process.cwd(), 'uploads', photo.storagePath);
            if (fs.existsSync(fullLocalPath)) {
              archive.file(fullLocalPath, { name: fileName });
            }
          }
        }

        await archive.finalize();
      } catch (err) {
        logger.error('Erro ao finalizar arquivo ZIP:', err);
        archive.abort();
      }
    })();

    return archive;
  }
}

export const galleryService = new GalleryService();
export default galleryService;
