import { StorageResult } from './local.storage.service.js';
import { logger } from '../utils/logger.js';

const GOOGLE_PHOTOS_BASE = 'https://photoslibrary.googleapis.com/v1';

export class GooglePhotosService {
  /**
   * Creates a new album in Google Photos.
   *
   * @param title The title of the album
   * @param accessToken Valid Google access token with photoslibrary scope
   * @returns Album ID
   */
  async createAlbum(title: string, accessToken: string): Promise<string> {
    if (!accessToken) {
      throw new Error('Token de acesso do Google é obrigatório para criar o álbum.');
    }

    try {
      const response = await fetch(`${GOOGLE_PHOTOS_BASE}/albums`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          album: {
            title,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Erro ao criar álbum no Google Photos:', {
          status: response.status,
          errorText,
        });
        throw new Error(`Google Photos API error: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as { id: string; title: string };
      logger.info(`Álbum criado no Google Photos com ID: ${data.id}`);
      return data.id;
    } catch (error) {
      logger.error('Falha na criação do álbum no Google Photos:', error);
      throw error;
    }
  }

  /**
   * Uploads a raw photo buffer into Google Photos and assigns it to the album.
   */
  async uploadToAlbum(
    file: Buffer,
    filename: string,
    albumId: string,
    accessToken: string,
    mimeType: string = 'image/jpeg'
  ): Promise<StorageResult> {
    if (!accessToken) {
      throw new Error('Token de acesso do Google não fornecido.');
    }
    if (!albumId) {
      throw new Error('ID do álbum do Google Photos não fornecido.');
    }

    try {
      // Step 1: Upload raw image bytes to obtain an upload token
      const uploadResponse = await fetch(`${GOOGLE_PHOTOS_BASE}/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/octet-stream',
          'X-Goog-Upload-Content-Type': mimeType,
          'X-Goog-Upload-Protocol': 'raw',
        },
        body: file as unknown as BodyInit,
      });

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        throw new Error(`Falha no upload de bytes para o Google Photos: ${uploadResponse.status} - ${errorText}`);
      }

      const uploadToken = await uploadResponse.text();

      // Step 2: Create media item in the specified album
      const batchResponse = await fetch(`${GOOGLE_PHOTOS_BASE}/mediaItems:batchCreate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          albumId,
          newMediaItems: [
            {
              description: filename,
              simpleMediaItem: {
                fileName: filename,
                uploadToken,
              },
            },
          ],
        }),
      });

      if (!batchResponse.ok) {
        const errorText = await batchResponse.text();
        throw new Error(`Falha ao registrar mídia no álbum: ${batchResponse.status} - ${errorText}`);
      }

      const batchResult = (await batchResponse.json()) as {
        newMediaItemResults?: Array<{
          status?: { message?: string; code?: number };
          mediaItem?: { id: string; baseUrl: string; productUrl?: string };
        }>;
      };

      const resultItem = batchResult.newMediaItemResults?.[0];
      if (!resultItem || !resultItem.mediaItem) {
        const errorStatus = resultItem?.status?.message || 'Erro desconhecido na criação do item';
        throw new Error(`Erro ao associar foto ao álbum do Google: ${errorStatus}`);
      }

      const mediaItem = resultItem.mediaItem;

      return {
        success: true,
        storagePath: mediaItem.id,
        provider: 'google_photos',
        publicUrl: mediaItem.baseUrl,
      };
    } catch (error) {
      logger.error('Erro ao fazer upload para Google Photos:', error);
      return {
        success: false,
        storagePath: '',
        provider: 'google_photos',
        error: error instanceof Error ? error.message : 'Falha no upload para o Google Photos',
      };
    }
  }

  /**
   * Implements StorageProvider uploadPhoto.
   */
  async uploadPhoto(
    file: Buffer,
    filename: string,
    mimeType: string,
    _eventId: number,
    extra?: { accessToken?: string; albumId?: string }
  ): Promise<StorageResult> {
    if (!extra?.accessToken || !extra?.albumId) {
      throw new Error('Google Photos requer accessToken e albumId válidos.');
    }
    return this.uploadToAlbum(file, filename, extra.albumId, extra.accessToken, mimeType);
  }

  /**
   * Google Photos API v1 does not provide a public delete endpoint for apps.
   */
  async deletePhoto(path: string): Promise<void> {
    logger.warn(
      `Exclusão no Google Photos via API não é suportada diretamente pelo Google para fotos de terceiros: ${path}`
    );
  }

  /**
   * Returns mediaItem URL or metadata lookup.
   */
  async getPhotoUrl(path: string): Promise<string> {
    if (path.startsWith('http')) {
      return path;
    }
    return path;
  }
}

export const googlePhotosService = new GooglePhotosService();
export default googlePhotosService;
