import sharp from 'sharp';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { events, photos, Photo } from '../models/schema.js';
import { localStorageService } from './local.storage.service.js';
import { logger } from '../utils/logger.js';

export interface UploadResult {
  id?: number;
  originalFilename: string;
  storedFilename: string;
  storageProvider: Photo['storageProvider'];
  storagePath: string;
  publicUrl?: string;
  fileSize: number;
  status: 'success' | 'failed' | 'duplicate';
  error?: string;
}

export class PhotoService {
  /**
   * Processes images using Sharp (resize max 2048px, 80 quality, EXIF orientation),
   * checks for duplicates via SHA-256 hash and stores them using local fallback storage.
   */
  async processAndUpload(
    files: Express.Multer.File[],
    eventId: number,
    _storageMode?: 'fallback'
  ): Promise<UploadResult[]> {
    if (!files || files.length === 0) {
      return [];
    }

    // 1. Fetch event details
    const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!event) {
      throw new Error('Evento não encontrado para upload de fotos.');
    }

    if (!event.isActive) {
      throw new Error('Este evento está inativo no momento e não aceita novos envios.');
    }

    const results: UploadResult[] = [];
    let successfullyAddedCount = 0;

    for (const file of files) {
      try {
        // 2. Image Optimization using Sharp
        const sharpInstance = sharp(file.buffer).rotate(); // Auto-rotate based on EXIF
        const metadata = await sharpInstance.metadata();

        if (
          (metadata.width && metadata.width > 2048) ||
          (metadata.height && metadata.height > 2048)
        ) {
          sharpInstance.resize({
            width: 2048,
            height: 2048,
            fit: 'inside',
            withoutEnlargement: true,
          });
        }

        // Compress to JPEG 80% quality
        const processedBuffer = await sharpInstance.jpeg({ quality: 80 }).toBuffer();
        const storedFilename = `${uuidv4()}.jpg`;
        const mimeType = 'image/jpeg';
        const fileSize = processedBuffer.length;

        // 3. Duplicate Detection via SHA-256 Hash
        const fileHash = crypto.createHash('sha256').update(processedBuffer).digest('hex');

        const existingPhoto = await db
          .select()
          .from(photos)
          .where(
            and(
              eq(photos.eventId, eventId),
              eq(photos.fileHash, fileHash),
              eq(photos.uploadStatus, 'success')
            )
          )
          .limit(1);

        if (existingPhoto.length > 0) {
          logger.info(`Foto duplicada detectada e ignorada: ${file.originalname}`);
          results.push({
            id: existingPhoto[0].id,
            originalFilename: file.originalname,
            storedFilename: existingPhoto[0].storedFilename,
            storageProvider: existingPhoto[0].storageProvider,
            storagePath: existingPhoto[0].storagePath,
            fileSize: existingPhoto[0].fileSize,
            status: 'duplicate',
            error: 'Esta foto já foi enviada anteriormente para este evento.',
          });
          continue;
        }

        // 4. Create initial pending record in DB
        const [photoRecord] = await db
          .insert(photos)
          .values({
            eventId,
            originalFilename: file.originalname,
            storedFilename,
            storagePath: 'pending',
            storageProvider: 'local',
            mimeType,
            fileSize,
            fileHash,
            uploadStatus: 'pending',
          })
          .returning();

        // 5. Store the processed image locally
        let finalProvider: 'local' = 'local';
        let storagePath = '';
        let publicUrl: string | undefined;

        const fallbackResult = await localStorageService.uploadPhoto(
          processedBuffer,
          storedFilename,
          mimeType,
          eventId
        );

        if (!fallbackResult.success) {
          throw new Error(fallbackResult.error || 'Falha no upload para o armazenamento de contingência.');
        }
        storagePath = fallbackResult.storagePath;
        publicUrl = fallbackResult.publicUrl;

        // 6. Update photo status in DB
        await db
          .update(photos)
          .set({
            storagePath,
            storageProvider: finalProvider,
            uploadStatus: 'success',
          })
          .where(eq(photos.id, photoRecord.id));

        successfullyAddedCount++;

        results.push({
          id: photoRecord.id,
          originalFilename: file.originalname,
          storedFilename,
          storageProvider: finalProvider,
          storagePath,
          publicUrl,
          fileSize,
          status: 'success',
        });
      } catch (fileError) {
        logger.error(`Erro ao processar foto ${file.originalname}:`, fileError);
        results.push({
          originalFilename: file.originalname,
          storedFilename: '',
          storageProvider: 'local',
          storagePath: '',
          fileSize: file.size,
          status: 'failed',
          error: fileError instanceof Error ? fileError.message : 'Erro ao processar imagem',
        });
      }
    }

    // 7. Update event photo_count
    if (successfullyAddedCount > 0) {
      await db
        .update(events)
        .set({
          photoCount: sql`${events.photoCount} + ${successfullyAddedCount}`,
          updatedAt: new Date(),
        })
        .where(eq(events.id, eventId));
    }

    return results;
  }
}

export const photoService = new PhotoService();
export default photoService;
