/**
 * Super admin console (audit trail + user management) and auditing of event deletion.
 * Database work is mocked; the audit writer is mocked globally in tests/setup.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { generateJWT } from '../src/services/auth.service.js';
import { eventService } from '../src/services/event.service.js';
import { userAdminService } from '../src/services/userAdmin.service.js';
import { listAuditLogs, recordAudit } from '../src/services/audit.service.js';

// User ids that do not exist in the database, so the token-version check accepts the test tokens
const SUPER_ADMIN = { id: 999911, email: 'superadmin-console@fotoqr.local', name: 'Super Admin', role: 'super_admin' };
const REGULAR_USER = { id: 999912, email: 'usuario-comum@fotoqr.local', name: 'Usuário Comum' };

const managedUser = {
  id: 999913,
  name: 'Maria Fotógrafa',
  email: 'maria@fotoqr.local',
  role: 'dj',
  isActive: true,
  createdAt: new Date(),
  eventCount: 2,
  photoCount: 40,
  isProtected: false,
};

const emptyAuditPage = { items: [], total: 0, page: 1, limit: 30, totalPages: 1, actions: [] };

describe('Super admin console', () => {
  const app = createApp();
  const superToken = generateJWT(SUPER_ADMIN as never);
  const userToken = generateJWT(REGULAR_USER as never);
  const asSuper = (req: request.Test) => req.set('Authorization', `Bearer ${superToken}`);
  const asUser = (req: request.Test) => req.set('Authorization', `Bearer ${userToken}`);

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(recordAudit).mockClear();
    vi.mocked(listAuditLogs).mockReset();
  });

  describe('access control', () => {
    it.each([
      ['get', '/api/admin/audit-logs'],
      ['get', '/api/admin/users'],
      ['patch', '/api/admin/users/1'],
      ['delete', '/api/admin/users/1'],
    ] as const)('%s %s requires login', async (method, path) => {
      const res = await request(app)[method](path);
      expect(res.status).toBe(401);
    });

    it.each([
      ['get', '/api/admin/audit-logs'],
      ['get', '/api/admin/users'],
      ['patch', '/api/admin/users/1'],
      ['delete', '/api/admin/users/1'],
    ] as const)('%s %s is forbidden to a regular user', async (method, path) => {
      const res = await asUser(request(app)[method](path));
      expect(res.status).toBe(403);
    });
  });

  describe('audit trail', () => {
    it('returns the trail with the filters from the query string', async () => {
      vi.mocked(listAuditLogs).mockResolvedValueOnce(emptyAuditPage);

      const res = await asSuper(
        request(app).get('/api/admin/audit-logs?page=2&action=EVENT_DELETE&search=ana&from=2026-11-01T03:00:00.000Z')
      );

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(0);
      expect(listAuditLogs).toHaveBeenCalledWith({
        page: 2,
        limit: undefined,
        action: 'EVENT_DELETE',
        search: 'ana',
        from: new Date('2026-11-01T03:00:00.000Z'),
        to: undefined,
      });
    });

    it('ignores an invalid date filter', async () => {
      vi.mocked(listAuditLogs).mockResolvedValueOnce(emptyAuditPage);
      await asSuper(request(app).get('/api/admin/audit-logs?from=ontem'));
      expect(vi.mocked(listAuditLogs).mock.calls[0][0]?.from).toBeUndefined();
    });
  });

  describe('user management', () => {
    it('lists users with filters', async () => {
      const list = vi
        .spyOn(userAdminService, 'listUsers')
        .mockResolvedValueOnce({ items: [managedUser], total: 1, page: 1, limit: 20, totalPages: 1 });

      const res = await asSuper(request(app).get('/api/admin/users?search=maria&status=inactive&role=dj'));

      expect(res.status).toBe(200);
      expect(res.body.data.items[0].email).toBe('maria@fotoqr.local');
      expect(list).toHaveBeenCalledWith(expect.objectContaining({ search: 'maria', status: 'inactive', role: 'dj' }));
    });

    it('changes a role and records it in the audit trail', async () => {
      const update = vi.spyOn(userAdminService, 'updateUser').mockResolvedValueOnce({
        user: { ...managedUser, role: 'super_admin' },
        changed: { role: { from: 'dj', to: 'super_admin' } },
      });

      const res = await asSuper(request(app).patch(`/api/admin/users/${managedUser.id}`).send({ role: 'super_admin' }));

      expect(res.status).toBe(200);
      expect(update).toHaveBeenCalledWith(SUPER_ADMIN.id, managedUser.id, { role: 'super_admin', isActive: undefined });
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'USER_ROLE_CHANGE',
          entityId: managedUser.id,
          actor: expect.objectContaining({ id: SUPER_ADMIN.id }),
          description: 'Perfil de maria@fotoqr.local alterado de DJ para Super admin',
        })
      );
    });

    it('records a deactivation', async () => {
      vi.spyOn(userAdminService, 'updateUser').mockResolvedValueOnce({
        user: { ...managedUser, isActive: false },
        changed: { isActive: { from: true, to: false } },
      });

      const res = await asSuper(request(app).patch(`/api/admin/users/${managedUser.id}`).send({ isActive: false }));

      expect(res.status).toBe(200);
      expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'USER_DEACTIVATE' }));
    });

    it('does not audit a request that changes nothing', async () => {
      vi.spyOn(userAdminService, 'updateUser').mockResolvedValueOnce({ user: managedUser, changed: {} });
      const res = await asSuper(request(app).patch(`/api/admin/users/${managedUser.id}`).send({ role: 'dj' }));
      expect(res.status).toBe(200);
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('refuses to change the super admin\'s own account', async () => {
      const res = await asSuper(request(app).patch(`/api/admin/users/${SUPER_ADMIN.id}`).send({ isActive: false }));
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('sua própria conta');
    });

    it('refuses to delete the super admin\'s own account', async () => {
      const res = await asSuper(request(app).delete(`/api/admin/users/${SUPER_ADMIN.id}`));
      expect(res.status).toBe(400);
    });

    it('rejects an invalid user id', async () => {
      const res = await asSuper(request(app).patch('/api/admin/users/abc').send({ isActive: false }));
      expect(res.status).toBe(400);
    });

    it('deletes a user with their events and photos and records it', async () => {
      vi.spyOn(userAdminService, 'deleteUser').mockResolvedValueOnce({
        user: managedUser,
        eventsDeleted: 2,
        photosDeleted: 40,
      });

      const res = await asSuper(request(app).delete(`/api/admin/users/${managedUser.id}`));

      expect(res.status).toBe(200);
      expect(res.body.photosDeleted).toBe(40);
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'USER_DELETE',
          metadata: expect.objectContaining({ eventsDeleted: 2, photosDeleted: 40, targetEmail: managedUser.email }),
        })
      );
    });
  });

  describe('event deletion', () => {
    it('reports how many photos were removed and records it in the audit trail', async () => {
      vi.spyOn(eventService, 'deleteEvent').mockResolvedValueOnce({
        event: { id: 77, uuid: 'evento-77', userId: REGULAR_USER.id, title: 'Formatura' } as never,
        photosDeleted: 12,
      });

      const res = await asUser(request(app).delete('/api/events/77'));

      expect(res.status).toBe(200);
      expect(res.body.photosDeleted).toBe(12);
      expect(res.body.message).toContain('12 foto(s) removida(s)');
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'EVENT_DELETE',
          eventId: 77,
          eventTitle: 'Formatura',
          metadata: expect.objectContaining({ photosDeleted: 12 }),
        })
      );
    });
  });
});
