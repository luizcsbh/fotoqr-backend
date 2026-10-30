import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import path from 'path';

import { env } from './config/env.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';

// Route imports
import authRoutes from './routes/auth.routes.js';
import eventRoutes from './routes/event.routes.js';
import photoRoutes from './routes/photo.routes.js';
import healthRoutes from './routes/health.routes.js';
import { getUserAvatar } from './services/auth.service.js';

export const createApp = (): Express => {
  const app: Express = express();

  // Trust proxy for rate limiting and secure cookies behind reverse proxies (Render, Cloudflare)
  app.set('trust proxy', 1);

  // Security Headers
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    })
  );

  // CORS Configuration
  const rawOrigins = [env.FRONTEND_URL, ...env.CORS_ALLOWED_ORIGINS];
  const splitOrigins = rawOrigins.flatMap((item) => (item ? item.split(',') : [])).map((s) => s.trim()).filter(Boolean);
  const allowedOrigins = new Set(
    splitOrigins
      .map((allowedOrigin) => {
        try {
          return new URL(allowedOrigin).origin;
        } catch {
          return null;
        }
      })
      .filter((origin): origin is string => origin !== null)
  );

  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);
        let requestOrigin: string;
        try {
          requestOrigin = new URL(origin).origin;
        } catch {
          return callback(new Error('Origem inválida pela política de CORS.'));
        }

        if (allowedOrigins.has(requestOrigin) || env.NODE_ENV === 'development') {
          return callback(null, true);
        }
        return callback(new Error('Origem não permitida pela política de CORS.'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    })
  );

  // Request Logging
  if (env.NODE_ENV !== 'test') {
    app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
  }

  // Body Parsing
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));

  // Cookie and Session Handling
  app.use(cookieParser());
  app.use(
    session({
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
      },
    })
  );

  // Serve local uploads folder (used when in local development / storage fallback)
  const uploadsPath = path.resolve(process.cwd(), 'uploads');
  app.use('/uploads', express.static(uploadsPath));

  // Health check endpoint (not rate-limited)
  app.use('/api/health', healthRoutes);

  // User avatar endpoint (publicly accessible, image cached)
  app.get('/api/users/:id/avatar', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = parseInt(req.params.id as string, 10);
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

  // General API Rate Limiter
  app.use('/api', apiLimiter);

  // Route Mounting
  app.use('/api/auth', authRoutes);
  app.use('/api/events', eventRoutes);
  app.use('/api', photoRoutes);

  // 404 Route Not Found Handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: `Rota não encontrada: ${req.method} ${req.originalUrl}`,
    });
  });

  // Global Centralized Error Handler
  app.use(errorHandler);

  return app;
};

export default createApp;
