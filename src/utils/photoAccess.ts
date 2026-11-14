import crypto from 'crypto';
import { env } from '../config/env.js';

/**
 * Photo files are served by sequential id. Without a key, anyone could walk /api/photos/1, 2, 3…
 * and download the photos of every event. URLs handed out by the API carry this per-photo key
 * (an HMAC of the id), so only people who received the URL from the gallery can open the file.
 */
export function photoAccessKey(photoId: number | string): string {
  return crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update(`photo:${photoId}`)
    .digest('base64url')
    .slice(0, 22);
}

export function isValidPhotoKey(photoId: number | string, key: unknown): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  const expected = Buffer.from(photoAccessKey(photoId));
  const given = Buffer.from(key);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** API URLs for a photo file and its thumbnail, including the access key. */
export function photoUrls(photoId: number | string): { url: string; thumbnailUrl: string } {
  const k = photoAccessKey(photoId);
  return {
    url: `/api/photos/${photoId}/file?k=${k}`,
    thumbnailUrl: `/api/photos/${photoId}/thumbnail?k=${k}`,
  };
}
