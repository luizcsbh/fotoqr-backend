/**
 * Fase 8 — Testes de Integração: Módulo de Convites com QR Code
 *
 * Padrão: idêntico ao event.test.ts — usa createApp() real + generateJWT + vi.spyOn.
 * Nenhum mock de módulos de infraestrutura. Apenas spies nos services chamados pelas rotas.
 *
 * Cobertura:
 *  - Autenticação obrigatória em todos os endpoints do módulo
 *  - Criação de convidado (cria com sucesso, bloqueia duplicado)
 *  - Geração de convite individual e em lote
 *  - Rota pública de convite (token válido e token inválido)
 *  - Validação de check-in: VALIDO, JA_UTILIZADO, INVALIDO, CANCELADO
 *  - Validação de campo obrigatório (token ausente → 400)
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { generateJWT } from '../src/services/auth.service.js';
import { guestService } from '../src/services/guest.service.js';
import { invitationService } from '../src/services/invitation.service.js';
import { checkinService } from '../src/services/checkin.service.js';

// Requisitos de RBAC: as rotas usam req.eventAccess para obter o eventId.
// O middleware requireEventAdmin/requireEventReader popula req.eventAccess via rbacService.
// Mockamos o rbacService para retornar um eventAccess válido sem hit no banco.
vi.mock('../src/middleware/rbac.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    requireEventAdmin: vi.fn((req: { eventAccess?: object }, _res: unknown, next: () => void) => {
      req.eventAccess = { eventId: 10, userId: 1, role: 'admin' };
      next();
    }),
    requireEventReader: vi.fn((req: { eventAccess?: object }, _res: unknown, next: () => void) => {
      req.eventAccess = { eventId: 10, userId: 1, role: 'reader' };
      next();
    }),
    rbacService: {
      resolveEventId: vi.fn().mockResolvedValue(10),
      getEventAccess: vi.fn().mockResolvedValue({ role: 'admin', userId: 1 }),
    },
  };
});

describe('Módulo de Convites com QR Code', () => {
  const app = createApp();

  const mockUser = {
    id: 1,
    email: 'admin@evento.com',
    name: 'Admin Evento',
    role: 'user' as const,
  };

  const authToken = generateJWT(mockUser);
  const authHeader = `Bearer ${authToken}`;

  // -------------------------------------------------------------------------
  // 1. Autenticação obrigatória
  // -------------------------------------------------------------------------
  describe('1. Autenticação obrigatória', () => {
    it('POST /api/events/:id/guests retorna 401 sem token', async () => {
      const res = await request(app)
        .post('/api/events/10/guests')
        .send({ name: 'Teste', email: 'teste@test.com' });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/checkin/validate retorna 401 sem token', async () => {
      const res = await request(app)
        .post('/api/checkin/validate')
        .send({ token: 'abc', eventId: 10 });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/invitations/:id/revoke retorna 401 sem token', async () => {
      const res = await request(app)
        .post('/api/invitations/5/revoke');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Cadastro de Convidados
  // -------------------------------------------------------------------------
  describe('2. Cadastro de Convidados', () => {
    it('cria convidado com sucesso — retorna 201 e dados do convidado', async () => {
      vi.spyOn(guestService, 'createGuest').mockResolvedValueOnce({
        id: 1,
        eventId: 10,
        name: 'João Silva',
        email: 'joao@example.com',
        phone: null,
        category: 'Geral',
        maxEntries: 1,
        notes: null,
        createdAt: new Date().toISOString(),
      } as never);

      const res = await request(app)
        .post('/api/events/10/guests')
        .set('Authorization', authHeader)
        .send({ name: 'João Silva', email: 'joao@example.com' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('id', 1);
      expect(res.body.data.name).toBe('João Silva');
    });

    it('rejeita e-mail duplicado — retorna 409', async () => {
      const err = Object.assign(new Error('E-mail já cadastrado neste evento.'), { statusCode: 409 });
      vi.spyOn(guestService, 'createGuest').mockRejectedValueOnce(err);

      const res = await request(app)
        .post('/api/events/10/guests')
        .set('Authorization', authHeader)
        .send({ name: 'João Silva', email: 'joao@example.com' });

      expect(res.status).toBe(409);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Geração de Convites com QR Code
  // -------------------------------------------------------------------------
  describe('3. Geração de Convites com QR Code', () => {
    it('gera convite individual — retorna 201 com rawToken e qrCodeUrl', async () => {
      vi.spyOn(invitationService, 'createInvitation').mockResolvedValueOnce({
        id: 5,
        eventId: 10,
        guestId: 1,
        rawToken: 'a'.repeat(64),
        qrCodeUrl: `https://fotoqr.app/convite/${'a'.repeat(64)}`,
        status: 'pending',
        usedCount: 0,
        maxUses: 1,
        createdAt: new Date().toISOString(),
      } as never);

      const res = await request(app)
        .post('/api/events/10/invitations')
        .set('Authorization', authHeader)
        .send({ guestId: 1 });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('rawToken');
      expect(res.body.data).toHaveProperty('qrCodeUrl');
      expect(res.body.data.status).toBe('pending');
    });

    it('gera convites em lote (bulk=true) — retorna 201 com contagem gerada', async () => {
      vi.spyOn(invitationService, 'generateBulkInvitations').mockResolvedValueOnce({
        generated: 5,
        skipped: 0,
        invitations: [],
      } as never);

      const res = await request(app)
        .post('/api/events/10/invitations')
        .set('Authorization', authHeader)
        .send({ bulk: true });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('generated', 5);
    });

    it('retorna 400 quando guestId não é informado (sem bulk)', async () => {
      const res = await request(app)
        .post('/api/events/10/invitations')
        .set('Authorization', authHeader)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Rota pública de convite
  // -------------------------------------------------------------------------
  describe('4. Rota pública de convite', () => {
    it('retorna 404 para token público inexistente', async () => {
      vi.spyOn(invitationService, 'getPublicInvitation').mockResolvedValueOnce(null as never);

      const res = await request(app)
        .get('/api/invitations/public/unknowntoken123');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('retorna dados do convite para token válido (200)', async () => {
      vi.spyOn(invitationService, 'getPublicInvitation').mockResolvedValueOnce({
        id: 5,
        guestName: 'João Silva',
        eventName: 'Casamento',
        status: 'pending',
        qrCodeDataUrl: 'data:image/png;base64,mock',
      } as never);

      const res = await request(app)
        .get('/api/invitations/public/validtoken123');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('guestName', 'João Silva');
    });
  });

  // -------------------------------------------------------------------------
  // 5. Validação de Check-in (POST /api/checkin/validate)
  // -------------------------------------------------------------------------
  describe('5. Validação de Check-in', () => {
    it('retorna VALIDO para token válido e não utilizado', async () => {
      vi.spyOn(checkinService, 'validateAndCheckin').mockResolvedValueOnce({
        result: 'VALIDO',
        allowed: true,
        guestName: 'João Silva',
        eventName: 'Casamento João & Maria',
        category: 'VIP',
        entriesUsed: 1,
        entriesMax: 1,
        checkinId: 42,
      } as never);

      const res = await request(app)
        .post('/api/checkin/validate')
        .set('Authorization', authHeader)
        .send({ token: 'validtoken123' });

      expect(res.status).toBe(200);
      expect(res.body.result).toBe('VALIDO');
      expect(res.body).toHaveProperty('guestName', 'João Silva');
    });

    it('retorna JA_UTILIZADO para token já consumido', async () => {
      vi.spyOn(checkinService, 'validateAndCheckin').mockResolvedValueOnce({
        result: 'JA_UTILIZADO',
        allowed: false,
        guestName: 'João Silva',
        entriesUsed: 1,
        entriesMax: 1,
      } as never);

      const res = await request(app)
        .post('/api/checkin/validate')
        .set('Authorization', authHeader)
        .send({ token: 'usedtoken' });

      expect(res.status).toBe(200);
      expect(res.body.result).toBe('JA_UTILIZADO');
    });

    it('retorna INVALIDO para token desconhecido', async () => {
      vi.spyOn(checkinService, 'validateAndCheckin').mockResolvedValueOnce({
        result: 'INVALIDO',
        allowed: false,
      } as never);

      const res = await request(app)
        .post('/api/checkin/validate')
        .set('Authorization', authHeader)
        .send({ token: 'unknownXXX' });

      expect(res.status).toBe(200);
      expect(res.body.result).toBe('INVALIDO');
    });

    it('retorna CANCELADO para convite revogado', async () => {
      vi.spyOn(checkinService, 'validateAndCheckin').mockResolvedValueOnce({
        result: 'CANCELADO',
        allowed: false,
        guestName: 'Maria Souza',
      } as never);

      const res = await request(app)
        .post('/api/checkin/validate')
        .set('Authorization', authHeader)
        .send({ token: 'cancelledtoken' });

      expect(res.status).toBe(200);
      expect(res.body.result).toBe('CANCELADO');
    });

    it('retorna 400 quando token não é fornecido no body', async () => {
      const res = await request(app)
        .post('/api/checkin/validate')
        .set('Authorization', authHeader)
        .send({});  // sem token nem qrCode

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('INVALIDO');
    });
  });
});
