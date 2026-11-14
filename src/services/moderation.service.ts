/**
 * Content Moderation Service for FotoQR
 *
 * Uses the Sightengine API when credentials are configured (SIGHTENGINE_USER + SIGHTENGINE_SECRET),
 * otherwise moderation is disabled and every photo is treated as safe (a loud warning is logged).
 *
 * Moderation categories checked: nudity, violence, gore.
 *
 * Decision per photo (highest score among the categories):
 * - score >= MODERATION_AUTO_REJECT_THRESHOLD (default 0.9) → 'rejected': discarded automatically
 * - score >= MODERATION_REVIEW_THRESHOLD (default 0.6)      → 'flagged': kept, goes to the owner's review queue
 * - below                                                    → 'safe': published normally
 * Setting both thresholds to the same value removes the manual review zone entirely.
 */

import { logger } from '../utils/logger.js';

export interface ModerationResult {
  safe: boolean;
  /**
   * - safe: checked and clean
   * - flagged: checked and likely inappropriate → manual review
   * - rejected: checked and almost certainly inappropriate → discarded without human intervention
   * - failed: the provider could not check the photo (network, quota, timeout)
   * - disabled: no provider configured
   */
  outcome: 'safe' | 'flagged' | 'rejected' | 'failed' | 'disabled';
  reason?: string;
  /** Raw confidence score from provider (0-1), higher = more likely to be inappropriate */
  score?: number;
}

/**
 * review_reason stored for photos the provider could not check. The retry job looks for this exact
 * text to re-moderate those photos once the provider is back.
 */
export const MODERATION_FAILED_REASON = 'A moderação automática não conseguiu analisar esta foto';

const SIGHTENGINE_ENDPOINT = 'https://api.sightengine.com/1.0/check.json';
const DEFAULT_MODELS = 'nudity-2.1,violence,gore-2.0';
const REQUEST_TIMEOUT_MS = 10_000;
/** Extra attempts for transient errors (network, timeout, HTTP 429/5xx) */
const MAX_RETRIES = 1;
/** After a non-transient error (bad credentials, quota exhausted) stop calling the API for a while */
const CIRCUIT_OPEN_MS = 5 * 60_000;

// Read lazily so the values never depend on module import order relative to dotenv.config()
const config = () => {
  const parse = (val: string | undefined, fallback: number) => {
    const n = Number(val);
    return val && Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
  };
  const review = parse(process.env.MODERATION_REVIEW_THRESHOLD, 0.6);
  const reject = parse(process.env.MODERATION_AUTO_REJECT_THRESHOLD, 0.9);
  return {
    user: process.env.SIGHTENGINE_USER || '',
    secret: process.env.SIGHTENGINE_SECRET || '',
    models: process.env.SIGHTENGINE_MODELS || DEFAULT_MODELS,
    reviewThreshold: Math.min(review, reject),
    rejectThreshold: reject,
  };
};

export function isModerationEnabled(): boolean {
  const { user, secret } = config();
  return Boolean(user && secret);
}

/** Logs the moderation setup once at startup (error level in production when it is off). */
export function logModerationStatus(nodeEnv: string): void {
  const c = config();
  if (!isModerationEnabled()) {
    const msg =
      '[moderation] SIGHTENGINE_USER/SIGHTENGINE_SECRET não configurados: a moderação automática está DESLIGADA e todas as fotos serão publicadas sem análise.';
    if (nodeEnv === 'production') logger.error(msg);
    else logger.warn(msg);
    return;
  }
  logger.info(
    `[moderation] Sightengine ativo (modelos: ${c.models}; revisão manual ≥ ${Math.round(c.reviewThreshold * 100)}%, recusa automática ≥ ${Math.round(c.rejectThreshold * 100)}%).`
  );
}

class ModerationProviderError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message);
  }
}

let circuitOpenUntil = 0;

/** Test helper: resets the circuit breaker state. */
export function resetModerationState(): void {
  circuitOpenUntil = 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function callSightengine(imageBuffer: Buffer, mimeType: string): Promise<any> {
  const c = config();
  // Native fetch/FormData (Node 18+): `form-data` is not a declared dependency, so importing it
  // failed in production installs and silently disabled moderation (fail-open).
  const form = new FormData();
  form.append('media', new Blob([new Uint8Array(imageBuffer)], { type: mimeType }), 'photo.jpg');
  form.append('models', c.models);
  form.append('api_user', c.user);
  form.append('api_secret', c.secret);

  let response: Response;
  try {
    response = await fetch(SIGHTENGINE_ENDPOINT, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ModerationProviderError(`Sightengine request failed: ${(err as Error).message}`, true);
  }

  const data = (await response.json().catch(() => null)) as any;

  // Sightengine reports errors with an HTTP error code plus { status: 'failure', error: {...} }.
  // A body without status 'success' must never be read as "no scores = safe" (fail-open).
  if (!response.ok || data?.status !== 'success') {
    const detail = data?.error?.message ? ` — ${data.error.message}` : '';
    const transient = response.status === 429 || response.status >= 500;
    throw new ModerationProviderError(`Sightengine API error: HTTP ${response.status}${detail}`, transient);
  }

  return data;
}

async function checkViaSightengine(imageBuffer: Buffer, mimeType: string): Promise<ModerationResult> {
  let data: any;
  for (let attempt = 0; ; attempt++) {
    try {
      data = await callSightengine(imageBuffer, mimeType);
      break;
    } catch (err) {
      const transient = err instanceof ModerationProviderError && err.transient;
      if (transient && attempt < MAX_RETRIES) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (!transient) circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
      throw err;
    }
  }

  // nudity-2.1 returns one score per class; take the highest of the explicit ones
  const nudityScore: number = Math.max(
    0,
    ...['sexual_activity', 'sexual_display', 'erotica'].map((key) => Number(data.nudity?.[key]) || 0)
  );
  const violenceScore: number = Number(data.violence?.prob) || 0;
  const goreScore: number = Number(data.gore?.prob) || 0;

  const categories: Array<[string, number]> = [
    ['Possível nudez ou conteúdo adulto', nudityScore],
    ['Possível conteúdo violento', violenceScore],
    ['Possível conteúdo gráfico impróprio', goreScore],
  ];
  const [label, score] = categories.reduce((top, cur) => (cur[1] > top[1] ? cur : top));
  const { reviewThreshold, rejectThreshold } = config();
  const reason = `${label} (${Math.round(score * 100)}% de confiança)`;

  if (score >= rejectThreshold) return { safe: false, outcome: 'rejected', reason, score };
  if (score >= reviewThreshold) return { safe: false, outcome: 'flagged', reason, score };
  return { safe: true, outcome: 'safe', score };
}

let warnedNoProvider = false;

/**
 * Main moderation function — used by the photo upload route and the retry job.
 * Flagged photos and photos the provider could not check are kept and sent to the event owner's
 * review queue; rejected photos are discarded by the caller.
 */
export async function moderateImage(imageBuffer: Buffer, mimeType: string): Promise<ModerationResult> {
  if (!isModerationEnabled()) {
    if (!warnedNoProvider) {
      warnedNoProvider = true;
      logger.warn(
        '[moderation] No moderation API configured. Set SIGHTENGINE_USER and SIGHTENGINE_SECRET to enable automatic content filtering.'
      );
    }
    return { safe: true, outcome: 'disabled' };
  }

  if (Date.now() < circuitOpenUntil) {
    return { safe: false, outcome: 'failed', reason: MODERATION_FAILED_REASON };
  }

  try {
    return await checkViaSightengine(imageBuffer, mimeType);
  } catch (err) {
    // Network issue, quota exceeded, timeout...: the photo is kept but goes to manual review;
    // the retry job re-checks it automatically once the provider answers again
    logger.error('[moderation] Moderation check failed — photo kept for automatic retry/manual review:', err);
    return { safe: false, outcome: 'failed', reason: MODERATION_FAILED_REASON };
  }
}
