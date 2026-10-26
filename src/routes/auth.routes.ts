import { Router, Request, Response, NextFunction } from 'express';
import {
  generateJWT,
  loginWithPassword,
  registerWithPassword,
} from '../services/auth.service.js';
import { optionalAuth, authenticateToken } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import { User } from '../models/schema.js';
import { env } from '../config/env.js';

const router = Router();

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
