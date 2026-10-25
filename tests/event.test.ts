import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { generateJWT } from '../src/services/auth.service.js';
import { eventService } from '../src/services/event.service.js';

describe('Event Routes and Service', () => {
  const app = createApp();

  const mockUser = {
    id: 1,
    email: 'organizador@evento.com',
    name: 'Carlos Organizador',
  };

  const validToken = generateJWT(mockUser);

  describe('Health Check Endpoint', () => {
    it('GET /api/health should respond with system status', async () => {
      const res = await request(app).get('/api/health');
      expect([200, 503]).toContain(res.status);
      expect(res.body.environment).toBeDefined();
      expect(res.body.services).toBeDefined();
    });
  });

  describe('Authentication Enforcement on Event Routes', () => {
    it('POST /api/events should return 401 when token is missing', async () => {
      const res = await request(app)
        .post('/api/events')
        .send({ title: 'Aniversário 15 anos' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Autenticação necessária');
    });

    it('GET /api/events should return 401 when token is missing', async () => {
      const res = await request(app).get('/api/events');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('PATCH /api/events/1/toggle should return 401 when token is missing', async () => {
      const res = await request(app).patch('/api/events/1/toggle');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('DELETE /api/events/1 should return 401 when token is missing', async () => {
      const res = await request(app).delete('/api/events/1');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe('Public Event View', () => {
    it('GET /api/events/:uuid should return 404 for unknown uuid', async () => {
      vi.spyOn(eventService, 'getEventByUuid').mockResolvedValueOnce(null);
      const res = await request(app).get('/api/events/non-existent-uuid-1234');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('não encontrado');
    });

    it('GET /api/events/:uuid should return event public info when event exists', async () => {
      const mockEventData = {
        id: 10,
        uuid: 'test-event-uuid-abc',
        userId: 1,
        title: 'Festa de Debutante',
        description: 'Tire suas fotos!',
        eventDate: new Date(),
        storageMode: 'google_photos' as const,
        googleAlbumId: null,
        isActive: true,
        photoCount: 15,
        publicUrl: 'http://localhost:5173/e/test-event-uuid-abc',
        qrCodeUrl: 'data:image/png;base64,mock',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(eventService, 'getEventByUuid').mockResolvedValueOnce(mockEventData);

      const res = await request(app).get('/api/events/test-event-uuid-abc');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe('Festa de Debutante');
      expect(res.body.data.photoCount).toBe(15);
      expect(res.body.data.qrCodeUrl).toBeDefined();
    });
  });

  describe('Event Creation with Auth', () => {
    it('POST /api/events should fail validation if title is empty', async () => {
      const res = await request(app)
        .post('/api/events')
        .set('Authorization', `Bearer ${validToken}`)
        .send({ title: '' });

      expect(res.status).toBe(400); // Validation failure returns 400 Bad Request
      expect(res.body.success).toBe(false);
    });

    it('POST /api/events should succeed when valid title is provided', async () => {
      const mockCreated = {
        id: 11,
        uuid: 'new-uuid-5678',
        userId: 1,
        title: 'Casamento Lucas e Bia',
        description: 'Fotos da cerimônia',
        eventDate: new Date(),
        storageMode: 'google_photos' as const,
        googleAlbumId: 'album-123',
        isActive: true,
        photoCount: 0,
        publicUrl: 'http://localhost:5173/e/new-uuid-5678',
        qrCodeUrl: 'data:image/png;base64,mock',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(eventService, 'createEvent').mockResolvedValueOnce(mockCreated);

      const res = await request(app)
        .post('/api/events')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          title: 'Casamento Lucas e Bia',
          description: 'Fotos da cerimônia',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.uuid).toBe('new-uuid-5678');
      expect(res.body.data.title).toBe('Casamento Lucas e Bia');
    });
  });

  describe('Event Toggle Active Status', () => {
    it('PATCH /api/events/:id/toggle should toggle event status', async () => {
      const mockToggled = {
        id: 11,
        uuid: 'new-uuid-5678',
        userId: 1,
        title: 'Casamento Lucas e Bia',
        description: 'Fotos da cerimônia',
        eventDate: new Date(),
        storageMode: 'google_photos' as const,
        googleAlbumId: 'album-123',
        isActive: false,
        photoCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.spyOn(eventService, 'toggleEventActive').mockResolvedValueOnce(mockToggled);

      const res = await request(app)
        .patch('/api/events/11/toggle')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isActive).toBe(false);
    });
  });
});
