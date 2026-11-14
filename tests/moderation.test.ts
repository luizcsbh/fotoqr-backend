import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  moderateImage,
  resetModerationState,
  MODERATION_FAILED_REASON,
} from '../src/services/moderation.service.js';

const img = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

const ok = (scores: { nudity?: number; violence?: number; gore?: number }) =>
  new Response(
    JSON.stringify({
      status: 'success',
      nudity: { sexual_activity: 0.01, sexual_display: scores.nudity ?? 0.01, erotica: 0.01 },
      violence: { prob: scores.violence ?? 0.01 },
      gore: { prob: scores.gore ?? 0.01 },
    }),
    { status: 200 }
  );

const failure = (status: number, message: string) =>
  new Response(JSON.stringify({ status: 'failure', error: { type: 'x', code: 1, message } }), { status });

describe('moderation.service', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.SIGHTENGINE_USER = 'user';
    process.env.SIGHTENGINE_SECRET = 'secret';
    delete process.env.MODERATION_REVIEW_THRESHOLD;
    delete process.env.MODERATION_AUTO_REJECT_THRESHOLD;
    resetModerationState();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SIGHTENGINE_USER;
    delete process.env.SIGHTENGINE_SECRET;
  });

  it('is disabled without credentials', async () => {
    delete process.env.SIGHTENGINE_USER;
    const res = await moderateImage(img, 'image/jpeg');
    expect(res.outcome).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('publishes clean photos', async () => {
    fetchMock.mockResolvedValueOnce(ok({}));
    expect((await moderateImage(img, 'image/jpeg')).outcome).toBe('safe');
  });

  it('sends medium-confidence photos to manual review', async () => {
    fetchMock.mockResolvedValueOnce(ok({ violence: 0.7 }));
    const res = await moderateImage(img, 'image/jpeg');
    expect(res.outcome).toBe('flagged');
    expect(res.reason).toContain('violento');
  });

  it('rejects high-confidence photos automatically', async () => {
    fetchMock.mockResolvedValueOnce(ok({ nudity: 0.95 }));
    const res = await moderateImage(img, 'image/jpeg');
    expect(res.outcome).toBe('rejected');
    expect(res.reason).toContain('nudez');
  });

  it('honours configurable thresholds (no manual review zone)', async () => {
    process.env.MODERATION_REVIEW_THRESHOLD = '0.8';
    process.env.MODERATION_AUTO_REJECT_THRESHOLD = '0.8';
    fetchMock.mockResolvedValueOnce(ok({ gore: 0.7 })).mockResolvedValueOnce(ok({ gore: 0.85 }));
    expect((await moderateImage(img, 'image/jpeg')).outcome).toBe('safe');
    expect((await moderateImage(img, 'image/jpeg')).outcome).toBe('rejected');
  });

  it('never treats an API failure body as safe', async () => {
    fetchMock.mockResolvedValueOnce(failure(200, 'weird'));
    const res = await moderateImage(img, 'image/jpeg');
    expect(res.outcome).toBe('failed');
    expect(res.reason).toBe(MODERATION_FAILED_REASON);
  });

  it('retries transient errors once', async () => {
    fetchMock.mockResolvedValueOnce(failure(503, 'unavailable')).mockResolvedValueOnce(ok({}));
    expect((await moderateImage(img, 'image/jpeg')).outcome).toBe('safe');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops calling the API for a while after a non-transient error (quota/credentials)', async () => {
    fetchMock.mockResolvedValue(failure(401, 'Incorrect API user or API secret'));
    expect((await moderateImage(img, 'image/jpeg')).outcome).toBe('failed');
    expect((await moderateImage(img, 'image/jpeg')).outcome).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
