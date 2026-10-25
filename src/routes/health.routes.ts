import { Router, Request, Response } from 'express';
import { checkDatabaseConnection } from '../config/database.js';
import { env } from '../config/env.js';

const router = Router();
const startTime = Date.now();

/**
 * GET /api/health
 * Health check endpoint providing database status, uptime, and system health.
 */
router.get('/', async (_req: Request, res: Response) => {
  const isDbConnected = await checkDatabaseConnection();
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  const status = isDbConnected ? 'healthy' : 'degraded';
  const statusCode = isDbConnected ? 200 : 503;

  res.status(statusCode).json({
    status,
    timestamp: new Date().toISOString(),
    uptime: `${uptimeSeconds}s`,
    environment: env.NODE_ENV,
    services: {
      database: isDbConnected ? 'connected' : 'disconnected',
    },
  });
});

export default router;
