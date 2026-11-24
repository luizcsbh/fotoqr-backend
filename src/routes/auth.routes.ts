import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import {
  generateJWT,
  loginWithPassword,
  registerWithPassword,
  updateProfile,
  changePassword,
  updateAvatar,
  getUserAvatar,
  requestPasswordReset,
  resetPasswordWithToken,
  AuthServiceError,
} from '../services/auth.service.js';
import { auditContext, recordAudit } from '../services/audit.service.js';
import { optionalAuth, authenticateToken, STAFF_COOKIE } from '../middleware/auth.js';
import { isSuperOrPlatformAdmin } from '../middleware/rbac.js';
import { authLimiter, registerLimiter } from '../middleware/rateLimiter.js';
import { User } from '../models/schema.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const router = Router();
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      callback(null, true);
      return;
    }
    callback(new Error('Formato de arquivo inválido. Use uma imagem JPG, PNG ou WEBP.'));
  },
});

function setAuthCookie(res: Response, token: string): void {
  res.cookie('fotoqr_token', token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function serializeUser(user: User) {
  const isSuper = isSuperOrPlatformAdmin(user.role, user.email);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: isSuper ? 'super_admin' : (user.role || 'user'),
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt,
  };
}

router.post('/register', registerLimiter, authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, password } = req.body ?? {};
    const user = await registerWithPassword({ name, email, password });
    setAuthCookie(res, generateJWT(user));
    await recordAudit({
      actor: { id: user.id, email: user.email, name: user.name },
      ipAddress: auditContext(req).ipAddress,
      action: 'USER_REGISTER',
      entityType: 'user',
      entityId: user.id,
      description: 'Nova conta criada',
    });
    res.status(201).json({ success: true, user: serializeUser(user) });
  } catch (error) {
    next(error);
  }
});

router.post('/login', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body ?? {};
    const user = await loginWithPassword(email, password);
    setAuthCookie(res, generateJWT(user));
    await recordAudit({
      actor: { id: user.id, email: user.email, name: user.name },
      ipAddress: auditContext(req).ipAddress,
      action: 'AUTH_LOGIN',
      entityType: 'user',
      entityId: user.id,
      description: 'Login realizado',
    });
    res.status(200).json({ success: true, user: serializeUser(user) });
  } catch (error) {
    if (error instanceof AuthServiceError && (error.statusCode === 401 || error.statusCode === 403)) {
      const attempted = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 255) : null;
      await recordAudit({
        actor: attempted ? { id: 0, email: attempted } : null,
        ipAddress: auditContext(req).ipAddress,
        action: error.statusCode === 403 ? 'AUTH_LOGIN_BLOCKED' : 'AUTH_LOGIN_FAILED',
        entityType: 'user',
        description: error.statusCode === 403 ? 'Login recusado: conta desativada' : 'Tentativa de login com senha incorreta',
      });
    }
    next(error);
  }
});

/**
 * GET /api/auth/me
 * Retrieves the currently authenticated user's profile.
 */
router.get('/me', optionalAuth, (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    user: req.user ?? null,
  });
});

router.patch('/profile', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await updateProfile(req.user!.id, req.body?.name);
    setAuthCookie(res, generateJWT(user));
    res.status(200).json({ success: true, user: serializeUser(user) });
  } catch (error) {
    next(error);
  }
});

router.put('/profile/password', authenticateToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await changePassword(req.user!.id, req.body?.currentPassword, req.body?.newPassword);
    await recordAudit({
      ...auditContext(req),
      action: 'PASSWORD_CHANGE',
      entityType: 'user',
      entityId: user.id,
      description: 'Senha alterada pelo próprio usuário',
    });
    // The password change signs out every other session; this one gets a fresh cookie
    setAuthCookie(res, generateJWT(user));
    res.status(200).json({ success: true, message: 'Senha alterada com sucesso. As outras sessões foram encerradas.' });
  } catch (error) {
    next(error);
  }
});

router.post(
  '/profile/avatar',
  authenticateToken,
  avatarUpload.single('avatar'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        res.status(400).json({ success: false, error: 'Selecione uma imagem para o avatar.' });
        return;
      }
      const user = await updateAvatar(req.user!.id, req.file.buffer);
      setAuthCookie(res, generateJWT(user));
      res.status(200).json({ success: true, user: serializeUser(user) });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/auth/avatar/:userId
 * Retrieves the user's avatar image directly from the database.
 */
router.get('/avatar/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = parseInt(req.params.userId as string, 10);
    if (isNaN(userId)) {
      res.status(400).send('ID de usuário inválido.');
      return;
    }

    const avatar = await getUserAvatar(userId);
    if (!avatar) {
      res.status(404).send('Avatar não encontrado.');
      return;
    }

    res.setHeader('Content-Type', avatar.mimeType);
    res.setHeader('Content-Length', avatar.data.length);
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    res.end(avatar.data);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/logout
 * Logs out the user and clears authentication cookies.
 */
router.post('/logout', (req: Request, res: Response) => {
  // Clears both the regular login and a DJ/reader exclusive-link session
  for (const cookieName of ['fotoqr_token', STAFF_COOKIE]) {
    res.clearCookie(cookieName, {
      path: '/',
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
    });
  }

  if (req.session) {
    req.session.destroy(() => {
      res.status(200).json({
        success: true,
        message: 'Desconectado com sucesso.',
      });
    });
  } else {
    res.status(200).json({
      success: true,
      message: 'Desconectado com sucesso.',
    });
  }
});

/**
 * POST /api/auth/forgot-password
 * Requests a password reset link by e-mail.
 */
router.post('/forgot-password', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body ?? {};
    try {
      await requestPasswordReset(email);
    } catch (err) {
      // A sending failure only happens for registered e-mails: answering with an error would reveal
      // which e-mails have an account. Log it for the admin and give the same answer as always.
      logger.error('Falha ao processar recuperação de senha:', err);
    }
    // Always respond with success (anti-enumeration)
    res.status(200).json({
      success: true,
      message: 'Se este e-mail estiver cadastrado, você receberá as instruções em breve.',
    });
  } catch (error: any) {
    // SMTP errors should propagate so the user knows to fix server config
    next(error);
  }
});

/**
 * POST /api/auth/reset-password
 * Resets the password using the token from the email link.
 */
router.post('/reset-password', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, token, newPassword } = req.body ?? {};
    if (!email || !token || !newPassword) {
      res.status(400).json({ success: false, error: 'Informe o e-mail, o token e a nova senha.' });
      return;
    }
    await resetPasswordWithToken(email, token, newPassword);
    await recordAudit({
      actor: { id: 0, email: String(email).trim().toLowerCase().slice(0, 255) },
      ipAddress: auditContext(req).ipAddress,
      action: 'PASSWORD_RESET',
      entityType: 'user',
      description: 'Senha redefinida pelo link enviado por e-mail',
    });
    res.status(200).json({ success: true, message: 'Senha redefinida com sucesso! Faça login com sua nova senha.' });
  } catch (error) {
    next(error);
  }
});

export default router;
