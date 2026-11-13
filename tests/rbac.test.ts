import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import {
  requirePlatformAdmin,
  requireEventAdmin,
  requireEventReader,
  rbacService,
} from '../src/middleware/rbac.js';

describe('RBAC Middleware (Access Control)', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.restoreAllMocks();
    app = express();
    app.use(express.json());

    // Middleware to inject mocked user
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const mockRole = req.headers['x-mock-role'] as string;
      const mockUserId = req.headers['x-mock-user-id'] as string;

      if (mockUserId) {
        req.user = {
          id: parseInt(mockUserId, 10),
          email: 'user@test.com',
          name: 'Test User',
          role: mockRole || 'user',
        };
      }
      next();
    });

    // Test routes for each middleware
    app.get('/test/platform-admin', requirePlatformAdmin, (_req: Request, res: Response) => {
      res.json({ success: true, message: 'Platform admin granted' });
    });

    app.get('/test/event/:id/admin', requireEventAdmin, (req: Request, res: Response) => {
      res.json({ success: true, eventAccess: req.eventAccess });
    });

    app.get('/test/event/:id/reader', requireEventReader, (req: Request, res: Response) => {
      res.json({ success: true, eventAccess: req.eventAccess });
    });
  });

  describe('requirePlatformAdmin', () => {
    it('returns 401 when user is not authenticated', async () => {
      const res = await request(app).get('/test/platform-admin');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 403 when user is not a platform admin', async () => {
      const res = await request(app)
        .get('/test/platform-admin')
        .set('x-mock-user-id', '1')
        .set('x-mock-role', 'user');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Administrador da Plataforma');
    });

    it('allows access when user has platform_admin role', async () => {
      const res = await request(app)
        .get('/test/platform-admin')
        .set('x-mock-user-id', '1')
        .set('x-mock-role', 'platform_admin');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('requireEventAdmin', () => {
    it('returns 401 when user is not authenticated', async () => {
      const res = await request(app).get('/test/event/10/admin');
      expect(res.status).toBe(401);
    });

    it('returns 404 when event does not exist', async () => {
      vi.spyOn(rbacService, 'resolveEventId').mockResolvedValueOnce(null);

      const res = await request(app)
        .get('/test/event/999/admin')
        .set('x-mock-user-id', '1');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('Evento não encontrado');
    });

    it('allows platform_admin unconditionally', async () => {
      vi.spyOn(rbacService, 'resolveEventId').mockResolvedValueOnce(10);

      const res = await request(app)
        .get('/test/event/10/admin')
        .set('x-mock-user-id', '99')
        .set('x-mock-role', 'platform_admin');

      expect(res.status).toBe(200);
      expect(res.body.eventAccess.isAdmin).toBe(true);
    });

    it('allows event owner / admin', async () => {
      vi.spyOn(rbacService, 'resolveEventId').mockResolvedValueOnce(10);
      vi.spyOn(rbacService, 'getEventAccess').mockResolvedValueOnce({
        eventId: 10,
        isOwner: true,
        isAdmin: true,
        isReader: true,
      });

      const res = await request(app)
        .get('/test/event/10/admin')
        .set('x-mock-user-id', '1');

      expect(res.status).toBe(200);
      expect(res.body.eventAccess.isAdmin).toBe(true);
    });

    it('blocks regular user without admin role with 403', async () => {
      vi.spyOn(rbacService, 'resolveEventId').mockResolvedValueOnce(10);
      vi.spyOn(rbacService, 'getEventAccess').mockResolvedValueOnce({
        eventId: 10,
        isOwner: false,
        isAdmin: false,
        isReader: false,
      });

      const res = await request(app)
        .get('/test/event/10/admin')
        .set('x-mock-user-id', '2');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('permissão de administração');
    });
  });

  describe('requireEventReader', () => {
    it('returns 401 when user is not authenticated', async () => {
      const res = await request(app).get('/test/event/10/reader');
      expect(res.status).toBe(401);
    });

    it('allows authorized QR reader', async () => {
      vi.spyOn(rbacService, 'resolveEventId').mockResolvedValueOnce(10);
      vi.spyOn(rbacService, 'getEventAccess').mockResolvedValueOnce({
        eventId: 10,
        isOwner: false,
        isAdmin: false,
        isReader: true,
      });

      const res = await request(app)
        .get('/test/event/10/reader')
        .set('x-mock-user-id', '5');

      expect(res.status).toBe(200);
      expect(res.body.eventAccess.isReader).toBe(true);
    });

    it('blocks user without reader permission with 403', async () => {
      vi.spyOn(rbacService, 'resolveEventId').mockResolvedValueOnce(10);
      vi.spyOn(rbacService, 'getEventAccess').mockResolvedValueOnce({
        eventId: 10,
        isOwner: false,
        isAdmin: false,
        isReader: false,
      });

      const res = await request(app)
        .get('/test/event/10/reader')
        .set('x-mock-user-id', '6');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('permissão de leitor de QR Code');
    });
  });
});
