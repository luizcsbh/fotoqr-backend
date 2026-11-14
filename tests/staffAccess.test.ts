import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { STAFF_COOKIE } from '../src/middleware/auth.js';
import { staffAccessService } from '../src/services/staffAccess.service.js';

// A user id that does not exist: in tests the session-version check accepts it (see decodeValidToken)
const staffToken = (kind: 'dj' | 'reader') =>
  jwt.sign(
    {
      id: 987654,
      email: `${kind}@example.com`,
      name: kind,
      role: kind,
      tv: 0,
      scope: { kind, eventId: 1, eventUuid: '00000000-0000-4000-8000-000000000000' },
    },
    env.JWT_SECRET
  );

describe('Staff exclusive-link sessions', () => {
  const app = createApp();

  it('GET /api/auth/me exposes the scope so the app can send the DJ to their console', async () => {
    const res = await request(app).get('/api/auth/me').set('Cookie', `${STAFF_COOKIE}=${staffToken('dj')}`);
    expect(res.status).toBe(200);
    expect(res.body.user.scope).toMatchObject({ kind: 'dj', eventId: 1 });
  });

  it('a DJ session cannot reach dashboard APIs', async () => {
    const res = await request(app).get('/api/events').set('Cookie', `${STAFF_COOKIE}=${staffToken('dj')}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/exclusivo do painel do DJ/);
  });

  it('a reader session cannot reach dashboard APIs nor the DJ console', async () => {
    const cookie = `${STAFF_COOKIE}=${staffToken('reader')}`;
    expect((await request(app).get('/api/events').set('Cookie', cookie)).status).toBe(403);
    expect((await request(app).patch('/api/events/abc/music/1/status').set('Cookie', cookie).send({ status: 'played' })).status).toBe(403);
  });

  it('a DJ session is not blocked on its own console routes', async () => {
    const res = await request(app)
      .patch('/api/events/abc/music/1/status')
      .set('Cookie', `${STAFF_COOKIE}=${staffToken('dj')}`)
      .send({ status: 'played' });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it('rejects malformed exclusive-link tokens without touching the database', async () => {
    expect(await staffAccessService.resolveToken('not-a-token')).toBeNull();
    expect(await staffAccessService.resolveToken('d1.short')).toBeNull();
    const res = await request(app).post('/api/staff-access').send({ token: 'x' });
    expect(res.status).toBe(404);
  });
});
