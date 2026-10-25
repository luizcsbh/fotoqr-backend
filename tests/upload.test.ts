import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { generateJWT } from '../src/services/auth.service.js';
import { eventService } from '../src/services/event.service.js';

describe('Photo Upload & Gallery Routes', () => {
  const app = createApp();
  const validToken = generateJWT({
    id: 1,
    email: 'organizador@evento.com',
    name: 'Carlos Organizador',
  });

  describe('POST /api/events/:uuid/photos', () => {
    it('should return 400 when no photos are attached', async () => {
      const res = await request(app).post('/api/events/some-event-uuid/photos');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Nenhuma foto foi selecionada');
    });

    it('should reject invalid non-image file uploads', async () => {
      const res = await request(app)
        .post('/api/events/some-event-uuid/photos')
        .attach('photos', Buffer.from('console.log("hello");'), 'script.js');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Formato de arquivo');
    });

    it('should return 404 when uploading to an event uuid that does not exist', async () => {
      vi.spyOn(eventService, 'getEventByUuid').mockResolvedValueOnce(null);
      const mockJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

      const res = await request(app)
        .post('/api/events/non-existent-uuid/photos')
        .attach('photos', mockJpeg, 'test-photo.jpg');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Evento não encontrado');
    });
  });

  describe('GET /api/events/:uuid/gallery', () => {
    it('should return 404 when fetching gallery for non-existent event', async () => {
      vi.spyOn(eventService, 'getEventByUuid').mockResolvedValueOnce(null);
      const res = await request(app).get('/api/events/unknown-uuid-123/gallery');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Evento não encontrado');
    });
  });

  describe('Photo Download & Delete Protection', () => {
    it('GET /api/events/1/photos/download requires authentication', async () => {
      const res = await request(app).get('/api/events/1/photos/download');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('DELETE /api/photos/1 requires authentication', async () => {
      const res = await request(app).delete('/api/photos/1');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('DELETE /api/photos/invalid-id returns 400 for bad id', async () => {
      const res = await request(app)
        .delete('/api/photos/abc')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('ID da foto inválido');
    });
  });
});
