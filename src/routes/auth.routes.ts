import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import {
  generateJWT,
  loginWithPassword,
  registerWithPassword,
  updateProfile,
  changePassword,
  updateAvatar,
  requestPasswordReset,
  resetPasswordWithToken,
} from '../services/auth.service.js';
import { optionalAuth, authenticateToken } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import { User } from '../models/schema.js';
import { env } from '../config/env.js';

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
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt,
  };
}

router.post('/register', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, password } = req.body ?? {};
    const user = await registerWithPassword({ name, email, password });
    setAuthCookie(res, generateJWT(user));
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
    res.status(200).json({ success: true, user: serializeUser(user) });
  } catch (error) {
    next(error);
  }
});

router.post('/forgot-password', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requestPasswordReset(req.body?.email);
    res.status(200).json({
      success: true,
      message: 'Se houver uma conta com esse e-mail, enviaremos um link de recuperação.',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/reset-password', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await resetPasswordWithToken(req.body?.token, req.body?.newPassword);
    res.status(200).json({ success: true, message: 'Senha redefinida. Você já pode entrar com a nova senha.' });
  } catch (error) {
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
    await changePassword(req.user!.id, req.body?.currentPassword, req.body?.newPassword);
    res.status(200).json({ success: true, message: 'Senha alterada com sucesso.' });
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
 * POST /api/auth/logout
 * Logs out the user and clears authentication cookies.
 */
router.post('/logout', (req: Request, res: Response) => {
  res.clearCookie('fotoqr_token', {
    path: '/',
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
  });

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

export default router;
