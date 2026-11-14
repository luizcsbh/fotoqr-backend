import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../config/database.js';
import { users } from '../models/schema.js';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role?: string;
  avatarUrl?: string | null;
  /** Session version (users.token_version) the token was issued for */
  tv?: number;
}

// Short cache so authenticated requests do not hit the database every time
const TOKEN_VERSION_TTL_MS = 30_000;
const tokenVersionCache = new Map<number, { version: number | null; at: number }>();

/** Drops the cached session version (call right after it changes in this process). */
export function forgetTokenVersion(userId: number): void {
  tokenVersionCache.delete(userId);
}

/** Current session version of the user, or null when the user no longer exists. */
async function currentTokenVersion(userId: number): Promise<number | null> {
  const cached = tokenVersionCache.get(userId);
  if (cached && Date.now() - cached.at < TOKEN_VERSION_TTL_MS) return cached.version;
  const [row] = await db
    .select({ tokenVersion: users.tokenVersion })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const version = row ? row.tokenVersion : null;
  tokenVersionCache.set(userId, { version, at: Date.now() });
  return version;
}

/**
 * Valid signature AND the session was not revoked by a password change (or the account removed).
 * Tokens issued before this check existed carry no version and count as version 0.
 */
async function decodeValidToken(token: string): Promise<AuthUser | null> {
  let decoded: AuthUser;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as AuthUser;
  } catch {
    return null;
  }
  const version = await currentTokenVersion(decoded.id);
  if (version === null || (decoded.tv ?? 0) !== version) return null;
  return decoded;
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
export async function authenticateToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({
      success: false,
      error: 'Autenticação necessária. Faça login para continuar.',
    });
    return;
  }

  let decoded: AuthUser | null;
  try {
    decoded = await decodeValidToken(token);
  } catch (error) {
    next(error); // database unavailable: let the error handler answer
    return;
  }

  if (!decoded) {
    res.status(401).json({
      success: false,
      error: 'Sessão expirada ou inválida. Faça login novamente.',
    });
    return;
  }

  req.user = {
    id: decoded.id,
    email: decoded.email,
    name: decoded.name,
    role: decoded.role || 'user',
    avatarUrl: decoded.avatarUrl || null,
  };
  next();
}

/**
 * Middleware that extracts user if token is present, but doesn't block unauthenticated requests.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);

  if (!token) {
    return next();
  }

  try {
    const decoded = await decodeValidToken(token);
    if (decoded) {
      req.user = {
        id: decoded.id,
        email: decoded.email,
        name: decoded.name,
        role: decoded.role || 'user',
        avatarUrl: decoded.avatarUrl || null,
      };
    }
  } catch {
    // Silently continue without user context
  }

  next();
}
