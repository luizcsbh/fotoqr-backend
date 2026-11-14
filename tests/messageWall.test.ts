import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { normalizeWhatsApp, validateGuestMessage } from '../src/services/messageWall.service.js';

describe('Mural de recados', () => {
  describe('normalizeWhatsApp', () => {
    it('accepts Brazilian numbers with DDD, with or without mask and country code', () => {
      expect(normalizeWhatsApp('(31) 99999-8888')).toBe('5531999998888');
      expect(normalizeWhatsApp('+55 31 99999-8888')).toBe('5531999998888');
      expect(normalizeWhatsApp('3133334444')).toBe('553133334444');
    });

    it('rejects numbers without DDD or with an invalid DDD', () => {
      expect(normalizeWhatsApp('99999-8888')).toBeNull();
      expect(normalizeWhatsApp('(01) 99999-8888')).toBeNull();
      expect(normalizeWhatsApp('')).toBeNull();
      expect(normalizeWhatsApp(31999998888)).toBeNull();
    });
  });

  describe('validateGuestMessage', () => {
    it('requires name, WhatsApp and message', () => {
      expect(() => validateGuestMessage({ phone: '31999998888', message: 'Oi' })).toThrow(/nome/);
      expect(() => validateGuestMessage({ name: 'Ana', message: 'Oi' })).toThrow(/WhatsApp/);
      expect(() => validateGuestMessage({ name: 'Ana', phone: '31999998888', message: '   ' })).toThrow(/mensagem/);
    });

    it('limits the message size and cleans the text', () => {
      expect(() =>
        validateGuestMessage({ name: 'Ana', phone: '31999998888', message: 'a'.repeat(501) })
      ).toThrow(/500/);
      expect(
        validateGuestMessage({ name: '  Ana   Souza ', phone: '31 99999-8888', message: ' Parabéns!\u0007\n\n\n\nFelicidades ' })
      ).toEqual({ name: 'Ana Souza', phone: '5531999998888', message: 'Parabéns!\n\nFelicidades' });
    });
  });

  describe('routes', () => {
    it('POST /api/events/:uuid/messages rejects an incomplete form before touching the database', async () => {
      const response = await request(createApp())
        .post('/api/events/00000000-0000-0000-0000-000000000000/messages')
        .send({ name: 'Ana', message: 'Felicidades!' });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/WhatsApp/);
    });

    it('owner routes require authentication', async () => {
      const app = createApp();
      expect((await request(app).get('/api/events/1/messages')).status).toBe(401);
      expect((await request(app).patch('/api/events/1/message-wall').send({ enabled: true })).status).toBe(401);
      expect((await request(app).delete('/api/events/1/messages/1')).status).toBe(401);
    });
  });
});
