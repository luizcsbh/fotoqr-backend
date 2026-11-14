import { Router, Request, Response, NextFunction } from 'express';
import { authenticateToken, STAFF_COOKIE } from '../middleware/auth.js';
import { requireEventAdmin } from '../middleware/rbac.js';
import { staffAccessService, StaffKind } from '../services/staffAccess.service.js';
import { env } from '../config/env.js';

const router = Router();

const KINDS: StaffKind[] = ['dj', 'reader'];

function parseStaffTarget(req: Request): { kind: StaffKind; userId: number } | null {
  const kind = req.params.kind as StaffKind;
  const userId = Number(req.params.userId);
  if (!KINDS.includes(kind) || !Number.isInteger(userId) || userId <= 0) return null;
  return { kind, userId };
}

/**
 * POST /api/staff-access
 * Opens a DJ / reader exclusive link: validates the token and starts a session restricted to that
 * staff console (it cannot open the dashboard or any other part of the app).
 * Body: { token }
 */
router.post('/staff-access', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const access = await staffAccessService.resolveToken(req.body?.token);
    if (!access) {
      res.status(404).json({
        success: false,
        error: 'Este link de acesso é inválido ou foi revogado. Peça um novo link ao organizador do evento.',
      });
      return;
    }

    res.cookie(STAFF_COOKIE, access.sessionToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    res.status(200).json({
      success: true,
      data: {
        kind: access.scope.kind,
        eventId: access.scope.eventId,
        eventUuid: access.scope.eventUuid,
        eventTitle: access.eventTitle,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/events/:id/staff/:kind/:userId/link
 * Returns the exclusive link of a DJ or reader (event admins only).
 */
router.get('/events/:id/staff/:kind/:userId/link', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = parseStaffTarget(req);
    if (!target) {
      res.status(400).json({ success: false, error: 'Parâmetros inválidos.' });
      return;
    }
    const link = await staffAccessService.getAccessLink(target.kind, req.eventAccess!.eventId, target.userId);
    res.status(200).json({ success: true, data: { link } });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/events/:id/staff/:kind/:userId/send-link
 * E-mails the exclusive link to the DJ or reader.
 */
router.post('/events/:id/staff/:kind/:userId/send-link', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = parseStaffTarget(req);
    if (!target) {
      res.status(400).json({ success: false, error: 'Parâmetros inválidos.' });
      return;
    }
    await staffAccessService.sendAccessEmail(target.kind, req.eventAccess!.eventId, target.userId);
    res.status(200).json({ success: true, message: 'Link de acesso enviado por e-mail.' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/events/:id/staff/:kind/:userId/regenerate-link
 * Issues a new exclusive link; the previous one stops working immediately.
 */
router.post('/events/:id/staff/:kind/:userId/regenerate-link', authenticateToken, requireEventAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = parseStaffTarget(req);
    if (!target) {
      res.status(400).json({ success: false, error: 'Parâmetros inválidos.' });
      return;
    }
    const link = await staffAccessService.regenerateAccessLink(target.kind, req.eventAccess!.eventId, target.userId);
    res.status(200).json({
      success: true,
      message: 'Novo link gerado. O link anterior não funciona mais.',
      data: { link },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
