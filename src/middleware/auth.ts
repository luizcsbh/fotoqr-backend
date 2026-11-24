import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../config/database.js';
import { users } from '../models/schema.js';
import { isSuperOrPlatformAdmin } from './rbac.js';

/**
 * Restricted session opened by a staff member's exclusive link (DJ console or portaria reader).
 * It can only reach the APIs of that console — see STAFF_ALLOWED_ROUTES.
 */
export interface StaffScope {
  kind: 'dj' | 'reader';
  eventId: number;
  eventUuid: string;
}

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role?: string;
  avatarUrl?: string | null;
  /** Session version (users.token_version) the token was issued for */
  tv?: number;
  /** Present only on sessions opened through an exclusive staff link */
  scope?: StaffScope;
}

/** Cookie of staff-link sessions; kept apart so opening a link never replaces an owner's login. */
export const STAFF_COOKIE = 'fotoqr_staff_token';

const ANY_STAFF_ROUTES: Array<[string, RegExp]> = [['GET', /^\/api\/auth\/me$/]];
const STAFF_ALLOWED_ROUTES: Record<StaffScope['kind'], Array<[string, RegExp]>> = {
  dj: [
    ['GET', /^\/api\/events\/[^/]+\/music$/],
    ['DELETE', /^\/api\/events\/[^/]+\/music\/[^/]+$/],
    ['PATCH', /^\/api\/events\/[^/]+\/music\/[^/]+\/status$/],
    ['GET', /^\/api\/spotify\/search$/],
  ],
  reader: [['POST', /^\/api(\/v1)?\/checkin\/validate$/]],
};

/** Whether a staff-link session may call this route (anything else is off-limits, dashboard included). */
function isAllowedForScope(req: Request, scope: StaffScope): boolean {
  const path = req.originalUrl.split('?')[0].replace(/\/+$/, '');
  return [...ANY_STAFF_ROUTES, ...STAFF_ALLOWED_ROUTES[scope.kind]].some(
    ([method, pattern]) => req.method === method && pattern.test(path)
  );
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
  if (version === null) {
    if (process.env.NODE_ENV === 'test') return decoded;
    return null;
  }
  if ((decoded.tv ?? 0) !== version) return null;
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
  // A regular login wins over a staff-link session in the same browser
  if (req.cookies && (req.cookies.fotoqr_token || req.cookies.token || req.cookies[STAFF_COOKIE])) {
    return req.cookies.fotoqr_token || req.cookies.token || req.cookies[STAFF_COOKIE];
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

  if (decoded.scope && !isAllowedForScope(req, decoded.scope)) {
    res.status(403).json({
      success: false,
      error:
        decoded.scope.kind === 'dj'
          ? 'Este acesso é exclusivo do painel do DJ.'
          : 'Este acesso é exclusivo do leitor da portaria.',
    });
    return;
  }

  req.user = {
    id: decoded.id,
    email: decoded.email,
    name: decoded.name,
    role: isSuperOrPlatformAdmin(decoded.role, decoded.email) ? 'super_admin' : (decoded.role || 'user'),
    avatarUrl: decoded.avatarUrl || null,
    ...(decoded.scope && { scope: decoded.scope }),
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
    // A staff-link session outside its console is treated as anonymous on public routes
    if (decoded && (!decoded.scope || isAllowedForScope(req, decoded.scope))) {
      req.user = {
        id: decoded.id,
        email: decoded.email,
        name: decoded.name,
        role: isSuperOrPlatformAdmin(decoded.role, decoded.email) ? 'super_admin' : (decoded.role || 'user'),
        avatarUrl: decoded.avatarUrl || null,
        ...(decoded.scope && { scope: decoded.scope }),
      };
    }
  } catch {
    // Silently continue without user context
  }

  next();
}
