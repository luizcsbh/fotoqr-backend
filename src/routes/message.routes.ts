import { Router, Request, Response, NextFunction } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { requireEventAdmin } from '../middleware/rbac.js';
import { messageLimiter } from '../middleware/rateLimiter.js';
import { messageWallService, MessageWallError } from '../services/messageWall.service.js';

const router = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof MessageWallError) {
        res.status(error.statusCode).json({ success: false, error: error.message });
        return;
      }
      next(error);
    }
  };

/**
 * POST /api/events/:uuid/messages
 * Public: a guest leaves a message on the wall. Name, WhatsApp and message are required.
 */
router.post(
  '/events/:uuid/messages',
  messageLimiter,
  handle(async (req, res) => {
    const saved = await messageWallService.createMessage(String(req.params.uuid), req.body);
    res.status(201).json({ success: true, message: 'Recado enviado! Ele já pode aparecer no telão.', data: saved });
  })
);

/**
 * PATCH /api/events/:id/message-wall
 * Owner turns the wall on/off. Body: { enabled?: boolean } — toggles when omitted.
 */
router.patch(
  '/events/:id/message-wall',
  authenticateToken,
  requireEventAdmin,
  handle(async (req, res) => {
    const enabled = req.body?.enabled;
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, error: 'O campo "enabled" deve ser verdadeiro ou falso.' });
      return;
    }
    const updated = await messageWallService.setEnabled(req.eventAccess!.eventId, req.user!.id, enabled);
    res.status(200).json({
      success: true,
      message: updated.enableMessageWall
        ? 'Mural de recados ativado. Os convidados já podem deixar mensagens.'
        : 'Mural de recados desativado.',
      data: updated,
    });
  })
);

/**
 * GET /api/events/:id/messages
 * Owner: every message, with the guest's WhatsApp.
 */
router.get(
  '/events/:id/messages',
  authenticateToken,
  requireEventAdmin,
  handle(async (req, res) => {
    const messages = await messageWallService.listForOwner(req.eventAccess!.eventId);
    res.status(200).json({ success: true, data: messages });
  })
);

/**
 * DELETE /api/events/:id/messages/:messageId
 * Owner removes a message (it disappears from the Telão on the next refresh).
 */
router.delete(
  '/events/:id/messages/:messageId',
  authenticateToken,
  requireEventAdmin,
  handle(async (req, res) => {
    const raw = String(req.params.messageId);
    if (!/^\d+$/.test(raw)) {
      res.status(400).json({ success: false, error: 'Recado inválido.' });
      return;
    }
    const deleted = await messageWallService.deleteMessage(req.eventAccess!.eventId, Number(raw));
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Recado não encontrado.' });
      return;
    }
    res.status(200).json({ success: true, message: 'Recado removido do mural.' });
  })
);

export default router;
