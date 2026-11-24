import { Router, Request, Response, NextFunction } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requirePlatformAdmin } from '../middleware/rbac.js';
import { auditContext, listAuditLogs, recordAudit } from '../services/audit.service.js';
import { userAdminService } from '../services/userAdmin.service.js';

/**
 * Super admin console: platform audit trail and user management.
 * Every route requires a logged-in super admin (or platform admin).
 */
const router = Router();
router.use(authenticateToken, requirePlatformAdmin);

const ROLE_LABELS: Record<string, string> = {
  user: 'Usuário',
  dj: 'DJ',
  reader: 'Leitor (portaria)',
  super_admin: 'Super admin',
};

const FIELD_LABELS: Record<string, string> = { name: 'nome', email: 'e-mail' };

const toInt = (value: unknown): number | undefined => {
  const n = parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : undefined;
};

const toDate = (value: unknown): Date | undefined => {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return isNaN(date.getTime()) ? undefined : date;
};

const toText = (value: unknown, max = 100): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

/**
 * GET /api/admin/audit-logs?page&limit&action&search&from&to
 */
router.get('/audit-logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await listAuditLogs({
      page: toInt(req.query.page),
      limit: toInt(req.query.limit),
      action: toText(req.query.action),
      search: toText(req.query.search),
      from: toDate(req.query.from),
      to: toDate(req.query.to),
    });
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin/users?page&limit&search&role&status
 */
router.get('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status === 'active' || req.query.status === 'inactive' ? req.query.status : undefined;
    const result = await userAdminService.listUsers({
      page: toInt(req.query.page),
      limit: toInt(req.query.limit),
      search: toText(req.query.search),
      role: toText(req.query.role, 50),
      status,
    });
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/users
 * Body: { name, email, password, role? } — creates an account that can log in right away.
 */
router.post('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, password, role } = req.body ?? {};
    const user = await userAdminService.createUser(req.user!.id, { name, email, password, role });
    await recordAudit({
      ...auditContext(req),
      action: 'USER_CREATE',
      entityType: 'user',
      entityId: user.id,
      description: `Conta de ${user.email} criada com o perfil ${ROLE_LABELS[user.role] ?? user.role}`,
      metadata: { targetEmail: user.email, targetName: user.name, role: user.role },
    });
    res.status(201).json({ success: true, message: 'Usuário criado com sucesso.', data: user });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /api/admin/users/:id
 * Body: { name?, email?, password?, role?: 'user' | 'dj' | 'reader', isActive?: boolean }
 */
router.patch('/users/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = toInt(req.params.id);
    if (!userId) {
      res.status(400).json({ success: false, error: 'ID de usuário inválido.' });
      return;
    }

    const { name, email, password, role, isActive } = req.body ?? {};
    const { user, changed } = await userAdminService.updateUser(req.user!.id, userId, {
      name,
      email,
      password,
      role,
      isActive,
    });
    const context = auditContext(req);

    const detailFields = Object.keys(changed).filter((field) => field in FIELD_LABELS);
    if (detailFields.length > 0) {
      await recordAudit({
        ...context,
        action: 'USER_UPDATE',
        entityType: 'user',
        entityId: user.id,
        description: `Dados de ${user.email} alterados: ${detailFields.map((f) => FIELD_LABELS[f]).join(' e ')}`,
        metadata: { targetEmail: user.email, changes: Object.fromEntries(detailFields.map((f) => [f, changed[f]])) },
      });
    }
    if (changed.password) {
      await recordAudit({
        ...context,
        action: 'USER_PASSWORD_SET',
        entityType: 'user',
        entityId: user.id,
        description: `Nova senha definida para ${user.email} pelo super admin`,
        metadata: { targetEmail: user.email },
      });
    }

    if (changed.role) {
      const from = ROLE_LABELS[String(changed.role.from)] ?? changed.role.from;
      const to = ROLE_LABELS[String(changed.role.to)] ?? changed.role.to;
      await recordAudit({
        ...context,
        action: 'USER_ROLE_CHANGE',
        entityType: 'user',
        entityId: user.id,
        description: `Perfil de ${user.email} alterado de ${from} para ${to}`,
        metadata: { targetEmail: user.email, from: changed.role.from, to: changed.role.to },
      });
    }
    if (changed.isActive) {
      await recordAudit({
        ...context,
        action: user.isActive ? 'USER_ACTIVATE' : 'USER_DEACTIVATE',
        entityType: 'user',
        entityId: user.id,
        description: `Conta de ${user.email} ${user.isActive ? 'reativada' : 'desativada'}`,
        metadata: { targetEmail: user.email },
      });
    }

    res.status(200).json({
      success: true,
      message: Object.keys(changed).length > 0 ? 'Usuário atualizado com sucesso.' : 'Nenhuma alteração a salvar.',
      data: user,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/admin/users/:id
 * Removes the user, their events and every photo of those events.
 */
router.delete('/users/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = toInt(req.params.id);
    if (!userId) {
      res.status(400).json({ success: false, error: 'ID de usuário inválido.' });
      return;
    }

    const { user, eventsDeleted, photosDeleted } = await userAdminService.deleteUser(req.user!.id, userId);
    await recordAudit({
      ...auditContext(req),
      action: 'USER_DELETE',
      entityType: 'user',
      entityId: user.id,
      description: `Conta de ${user.email} excluída com ${eventsDeleted} evento(s) e ${photosDeleted} foto(s)`,
      metadata: { targetEmail: user.email, targetName: user.name, eventsDeleted, photosDeleted },
    });

    res.status(200).json({
      success: true,
      message: `Usuário excluído. ${eventsDeleted} evento(s) e ${photosDeleted} foto(s) removidos.`,
      eventsDeleted,
      photosDeleted,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
