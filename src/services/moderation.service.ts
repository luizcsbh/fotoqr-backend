/**
 * Content Moderation Service for FotoQR
 *
 * Uses the Sightengine API when credentials are configured (SIGHTENGINE_USER + SIGHTENGINE_SECRET),
 * otherwise falls back to a lightweight heuristic check (file size / metadata only).
 *
 * Moderation categories checked: nudity, violence, gore.
 */

import { logger } from '../utils/logger.js';

export interface ModerationResult {
  safe: boolean;
  reason?: string;
  /** Raw confidence score from provider (0-1), higher = more likely to be flagged */
  score?: number;
}

const SIGHTENGINE_USER = process.env.SIGHTENGINE_USER || '';
const SIGHTENGINE_SECRET = process.env.SIGHTENGINE_SECRET || '';
const SIGHTENGINE_MODELS = 'nudity-2.1,violence,gore-2.0';

/**
 * Calls Sightengine API for image content moderation.
 * Throws on network error; returns ModerationResult.
 */
async function checkViaSightengine(imageBuffer: Buffer, mimeType: string): Promise<ModerationResult> {
  // Native fetch/FormData (Node 18+): `form-data` is not a declared dependency, so importing it
  // failed in production installs and silently disabled moderation (fail-open).
  const form = new FormData();
  form.append('media', new Blob([new Uint8Array(imageBuffer)], { type: mimeType }), 'photo.jpg');
  form.append('models', SIGHTENGINE_MODELS);
  form.append('api_user', SIGHTENGINE_USER);
  form.append('api_secret', SIGHTENGINE_SECRET);

  const response = await fetch('https://api.sightengine.com/1.0/check.json', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Sightengine API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as any;

  // Evaluate nudity
  // nudity-2.1 returns one score per class; `??` would only ever read sexual_activity
  // (always present), ignoring explicit nudity reported under the other classes
  const nudityScore: number = Math.max(
    0,
    ...['sexual_activity', 'sexual_display', 'erotica'].map((key) => Number(data.nudity?.[key]) || 0)
  );

  // Evaluate violence
  const violenceScore: number = data.violence?.prob ?? 0;

  // Evaluate gore
  const goreScore: number = data.gore?.prob ?? 0;

  const THRESHOLD = 0.6; // Flag if any category is above 60% confidence

  if (nudityScore > THRESHOLD) {
    return {
      safe: false,
      reason: 'A imagem foi identificada como contendo conteúdo adulto ou nudez.',
      score: nudityScore,
    };
  }

  if (violenceScore > THRESHOLD) {
    return {
      safe: false,
      reason: 'A imagem foi identificada como contendo conteúdo violento.',
      score: violenceScore,
    };
  }

  if (goreScore > THRESHOLD) {
    return {
      safe: false,
      reason: 'A imagem foi identificada como contendo conteúdo gráfico impróprio.',
      score: goreScore,
    };
  }

  return { safe: true, score: Math.max(nudityScore, violenceScore, goreScore) };
}

/**
 * Lightweight heuristic fallback when no moderation API is configured.
 * Checks only basic metadata (always safe from moderation perspective).
 * In production, configure SIGHTENGINE_USER + SIGHTENGINE_SECRET for real moderation.
 */
let warnedNoProvider = false;

function heuristicCheck(_buffer: Buffer): ModerationResult {
  // Without an ML model, we cannot reliably detect nudity/violence.
  // Return safe=true and warn once (not per photo) so operators know real moderation is disabled.
  if (!warnedNoProvider) {
    warnedNoProvider = true;
    logger.warn(
      '[moderation] No moderation API configured. Set SIGHTENGINE_USER and SIGHTENGINE_SECRET in .env to enable automatic content filtering.'
    );
  }
  return { safe: true };
}

/**
 * Main moderation function — use in photo upload middleware.
 * Returns { safe: true } to allow, or { safe: false, reason: '...' } to block.
 */
export async function moderateImage(imageBuffer: Buffer, mimeType: string): Promise<ModerationResult> {
  try {
    if (SIGHTENGINE_USER && SIGHTENGINE_SECRET) {
      return await checkViaSightengine(imageBuffer, mimeType);
    }
    return heuristicCheck(imageBuffer);
  } catch (err) {
    // If moderation API fails (network issue, quota exceeded), fail-open to avoid
    // blocking legitimate uploads. Log the error for operator review.
    logger.error('[moderation] Moderation check failed — defaulting to safe:', err);
    return { safe: true };
  }
}
