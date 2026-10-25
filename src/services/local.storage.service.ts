import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

export interface StorageResult {
  success: boolean;
  storagePath: string;
  provider: 'google_photos' | 'local' | 'supabase';
  publicUrl?: string;
  error?: string;
}

/**
 * LocalStorageService — stores all uploaded photos on the local filesystem
 * under the `uploads/event_<id>/` directory.
 */
export class LocalStorageService {
  private readonly uploadDir: string;

  constructor() {
    this.uploadDir = path.resolve(process.cwd(), 'uploads');
    if (!fs.existsSync(this.uploadDir)) {
      try {
        fs.mkdirSync(this.uploadDir, { recursive: true });
      } catch (e) {
        // Ignored in restricted environments
      }
    }
  }

  /**
   * Saves an image buffer to `uploads/event_<eventId>/<filename>`.
   */
  async uploadPhoto(
    file: Buffer,
    filename: string,
    mimeType: string,
    eventId: number
  ): Promise<StorageResult> {
    try {
      const eventDir = path.join(this.uploadDir, `event_${eventId}`);
      if (!fs.existsSync(eventDir)) {
        fs.mkdirSync(eventDir, { recursive: true });
      }

      const fullPath = path.join(eventDir, filename);
      fs.writeFileSync(fullPath, file);

      const storagePath = `event_${eventId}/${filename}`;
      const publicUrl = `${env.BACKEND_PUBLIC_URL}/uploads/${storagePath}`;

      return {
        success: true,
        storagePath,
        provider: 'local',
        publicUrl,
      };
    } catch (error) {
      logger.error('Erro ao salvar foto localmente:', error);
      return {
        success: false,
        storagePath: '',
        provider: 'local',
        error: error instanceof Error ? error.message : 'Falha no armazenamento local',
      };
    }
  }

  /**
   * Deletes a photo from the local filesystem.
   */
  async deletePhoto(storagePath: string): Promise<void> {
    try {
      const fullPath = path.join(this.uploadDir, storagePath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } catch (error) {
      logger.error('Erro ao excluir foto local:', error);
    }
  }

  /**
   * Returns the public URL for accessing a locally stored photo.
   */
  getPhotoUrl(storagePath: string): string {
    return `/uploads/${storagePath}`;
  }
}

export const localStorageService = new LocalStorageService();
export default localStorageService;
