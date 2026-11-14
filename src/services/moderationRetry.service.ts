import { and, eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { events, photos } from '../models/schema.js';
import { logger } from '../utils/logger.js';
import { MODERATION_FAILED_REASON, isModerationEnabled, moderateImage } from './moderation.service.js';
import { photoService } from './photo.service.js';

const RETRY_INTERVAL_MS = 10 * 60_000;
const BATCH_SIZE = 25;

let running = false;

/**
 * Re-moderates photos that were kept in the review queue only because the provider could not check
 * them (network error, quota, timeout). Each photo then follows the normal automatic decision:
 * - safe     → published (or left for the host when the event requires manual approval)
 * - flagged  → stays in the review queue, now with the real reason
 * - rejected → deleted
 * - failed   → left untouched; the batch stops because the provider is still unavailable
 */
export async function retryFailedModeration(): Promise<{ checked: number; published: number; rejected: number }> {
  const stats = { checked: 0, published: 0, rejected: 0 };
  if (running || !isModerationEnabled()) return stats;
  running = true;

  try {
    const pending = await db
      .select({
        id: photos.id,
        eventId: photos.eventId,
        fileData: photos.fileData,
        mimeType: photos.mimeType,
        requirePhotoApproval: events.requirePhotoApproval,
      })
      .from(photos)
      .innerJoin(events, eq(photos.eventId, events.id))
      .where(and(eq(photos.reviewStatus, 'pending'), eq(photos.reviewReason, MODERATION_FAILED_REASON)))
      .limit(BATCH_SIZE);

    for (const photo of pending) {
      if (!photo.fileData) continue;
      const result = await moderateImage(Buffer.from(photo.fileData), photo.mimeType);
      if (result.outcome === 'failed') break;
      stats.checked++;

      if (result.outcome === 'rejected') {
        await db.delete(photos).where(and(eq(photos.id, photo.id), eq(photos.reviewStatus, 'pending')));
        stats.rejected++;
        logger.warn(`[moderation] Foto ${photo.id} recusada automaticamente na reanálise: ${result.reason}`);
      } else if (result.outcome === 'flagged') {
        await db.update(photos).set({ reviewReason: result.reason ?? null }).where(eq(photos.id, photo.id));
      } else {
        await db.update(photos).set({ reviewReason: null }).where(eq(photos.id, photo.id));
        // Clean: publish it, unless the host asked to approve every photo of this event by hand
        if (!photo.requirePhotoApproval) {
          stats.published += await photoService.approvePhotos(photo.eventId, [photo.id]);
        }
      }
    }

    if (stats.checked > 0) {
      logger.info(
        `[moderation] Reanálise: ${stats.checked} foto(s) verificadas, ${stats.published} publicadas, ${stats.rejected} recusadas.`
      );
    }
  } catch (err) {
    logger.error('[moderation] Falha na reanálise de fotos pendentes:', err);
  } finally {
    running = false;
  }
  return stats;
}

/** Starts the periodic retry job (no-op when moderation is disabled). */
export function startModerationRetryJob(): void {
  if (!isModerationEnabled()) return;
  const timer = setInterval(() => void retryFailedModeration(), RETRY_INTERVAL_MS);
  timer.unref();
  // First pass shortly after boot, to drain photos left over from a previous outage
  setTimeout(() => void retryFailedModeration(), 30_000).unref();
}
