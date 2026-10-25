import { Router, Request, Response, NextFunction } from 'express';
import {
  getGoogleAuthUrl,
  handleGoogleCallback,
  generateJWT,
} from '../services/auth.service.js';
import { authenticateToken } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * GET /api/auth/google
 * Initiates the Google OAuth login flow.
 */
router.get('/google', (req: Request, res: Response) => {
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;
  const authUrl = getGoogleAuthUrl(state);
  res.redirect(authUrl);
});

/**
 * GET /api/auth/google/callback
 * Handles the OAuth code exchange callback from Google.
 */
router.get('/google/callback', async (req: Request, res: Response, next: NextFunction) => {
  const code = req.query.code as string;
  const error = req.query.error as string;

  if (error) {
    logger.error('Erro retornado na autorização do Google OAuth:', error);
    res.redirect(`${env.FRONTEND_URL}/login?error=${encodeURIComponent(error)}`);
    return;
  }

  if (!code) {
    res.redirect(`${env.FRONTEND_URL}/login?error=missing_code`);
    return;
  }

  try {
    const user = await handleGoogleCallback(code);
    const token = generateJWT(user);

    // Set secure HTTP-only cookie
    res.cookie('fotoqr_token', token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/',
    });

    // Redirect to frontend dashboard
    res.redirect(`${env.FRONTEND_URL}/dashboard?login=success`);
  } catch (err) {
    logger.error('Erro ao processar callback do Google:', err);
    res.redirect(`${env.FRONTEND_URL}/login?error=auth_failed`);
  }
});

/**
 * GET /api/auth/me
 * Retrieves the currently authenticated user's profile.
 */
router.get('/me', authenticateToken, (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    user: req.user,
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
