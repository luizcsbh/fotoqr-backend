/**
 * Super admin must see every event's photos (approved, pending review and ZIP download),
 * including events created by other users and addressed by their numeric id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { generateJWT } from '../src/services/auth.service.js';
import { eventService } from '../src/services/event.service.js';
import { galleryService } from '../src/services/gallery.service.js';

// User ids that do not exist in the database, so the token-version check accepts the test tokens
const SUPER_ADMIN = { id: 999901, email: 'superadmin-test@fotoqr.local', name: 'Super Admin', role: 'super_admin' };
const OTHER_USER = { id: 999902, email: 'outro-usuario@fotoqr.local', name: 'Outro Usuário' };
const EVENT_OWNER_ID = 999903;

const otherUsersEvent = {
  id: 42,
  uuid: 'evento-de-outro-usuario',
  userId: EVENT_OWNER_ID,
  title: 'Casamento da Ana',
} as never;

const photo = {
  id: 7,
  eventId: 42,
  storedFilename: 'foto.jpg',
  originalFilename: 'foto.jpg',
  url: '/api/photos/7/file',
  thumbnail_url: '/api/photos/7/thumb',
  fileSize: 1234,
  mimeType: 'image/jpeg',
  storageProvider: 'database',
  reviewStatus: 'pending',
  reviewReason: 'Moderação automática',
  uploadedAt: new Date(),
};

const galleryPage = (photos: unknown[]) =>
  ({ photos, pagination: { total: photos.length, page: 1, limit: 20, totalPages: 1 } }) as never;

describe('Super admin access to every photo', () => {
  const app = createApp();
  const superToken = generateJWT(SUPER_ADMIN as never);
  const userToken = generateJWT(OTHER_USER as never);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the approved photos of an event owned by another user (numeric id)', async () => {
    const lookup = vi.spyOn(eventService, 'getEventByIdOrUuid').mockResolvedValueOnce(otherUsersEvent);
    vi.spyOn(galleryService, 'getEventPhotos').mockResolvedValueOnce(galleryPage([{ ...photo, reviewStatus: 'approved' }]));

    const res = await request(app).get('/api/events/42/photos').set('Authorization', `Bearer ${superToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // The role must reach the lookup, or numeric ids only resolve for the event owner
    expect(lookup).toHaveBeenCalledWith('42', SUPER_ADMIN.id, 'super_admin', SUPER_ADMIN.email);
  });

  it('lists the photos waiting for review of an event owned by another user', async () => {
    vi.spyOn(eventService, 'getEventByIdOrUuid').mockResolvedValueOnce(otherUsersEvent);
    const list = vi.spyOn(galleryService, 'getEventPhotos').mockResolvedValueOnce(galleryPage([photo]));

    const res = await request(app)
      .get('/api/events/42/photos?review=pending')
      .set('Authorization', `Bearer ${superToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data[0].review_reason).toBe('Moderação automática');
    expect(list).toHaveBeenCalledWith(42, 1, 20, 'pending');
  });

  it('still blocks the review queue for a user who does not own the event', async () => {
    vi.spyOn(eventService, 'getEventByIdOrUuid').mockResolvedValueOnce(otherUsersEvent);

    const res = await request(app)
      .get('/api/events/evento-de-outro-usuario/photos?review=pending')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
  });

  it('passes the super admin role to the ZIP download lookup', async () => {
    const lookup = vi.spyOn(eventService, 'getEventByIdOrUuid').mockResolvedValueOnce(null);

    await request(app).get('/api/events/42/download').set('Authorization', `Bearer ${superToken}`);

    expect(lookup).toHaveBeenCalledWith('42', SUPER_ADMIN.id, 'super_admin', SUPER_ADMIN.email);
  });
});
