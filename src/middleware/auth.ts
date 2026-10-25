import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  avatarUrl?: string | null;
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Extracts JWT token from HTTP-only cookie or Authorization header.
 */
function extractToken(req: Request): string | null {
  if (req.cookies && (req.cookies.fotoqr_token || req.cookies.token)) {
    return req.cookies.fotoqr_token || req.cookies.token;
  }

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }

  return null;
}

/**
 * Middleware requiring valid JWT authentication.
 */
export function authenticateToken(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({
      success: false,
      error: 'Autenticação necessária. Faça login para continuar.',
    });
    return;
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as AuthUser;
    req.user = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.name,
      avatarUrl: decoded.avatarUrl || null,
    };
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Sessão expirada ou inválida. Faça login novamente.',
    });
    return;
  }
}

/**
 * Middleware that extracts user if token is present, but doesn't block unauthenticated requests.
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (!token) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as AuthUser;
    req.user = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.name,
      avatarUrl: decoded.avatarUrl || null,
    };
  } catch {
    // Silently continue without user context
  }

  next();
}
