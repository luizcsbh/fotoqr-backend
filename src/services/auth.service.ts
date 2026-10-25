import { google } from 'googleapis';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users, credentials, User } from '../models/schema.js';
import { encryptToken, decryptToken } from '../utils/encryption.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { AuthUser } from '../middleware/auth.js';

// Setup Google OAuth2 Client
export function getOAuth2Client() {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI
  );
}

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/photoslibrary',
  'https://www.googleapis.com/auth/photoslibrary.appendonly',
  'https://www.googleapis.com/auth/photoslibrary.sharing',
];

/**
 * Generates the Google OAuth authorization URL for user login.
 */
export function getGoogleAuthUrl(state?: string): string {
  const oauth2Client = getOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // Ensures refresh token is provided
    scope: SCOPES,
    state,
  });
}

/**
 * Handles the Google OAuth callback, verifies tokens, and creates/updates the user.
 */
export async function handleGoogleCallback(code: string): Promise<User> {
  const oauth2Client = getOAuth2Client();

  // Exchange code for tokens
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Retrieve user info from Google
  const oauth2 = google.oauth2({ auth: oauth2Client, version: 'v2' });
  const { data: profile } = await oauth2.userinfo.get();

  if (!profile.id || !profile.email) {
    throw new Error('Não foi possível obter as informações do perfil do Google.');
  }

  const googleId = profile.id;
  const email = profile.email;
  const name = profile.name || profile.email.split('@')[0];
  const avatarUrl = profile.picture || null;

  // Check if user already exists
  const existingUsers = await db.select().from(users).where(eq(users.googleId, googleId)).limit(1);
  let user: User;

  if (existingUsers.length > 0) {
    // Update existing user profile
    const [updatedUser] = await db
      .update(users)
      .set({
        name,
        email,
        avatarUrl,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existingUsers[0].id))
      .returning();
    user = updatedUser;
  } else {
    // Insert new user
    const [newUser] = await db
      .insert(users)
      .values({
        googleId,
        email,
        name,
        avatarUrl,
      })
      .returning();
    user = newUser;
  }

  // Handle credentials storage (refresh token & access token)
  const existingCreds = await db
    .select()
    .from(credentials)
    .where(eq(credentials.userId, user.id))
    .limit(1);

  const encryptedAccessToken = tokens.access_token ? encryptToken(tokens.access_token) : null;
  const tokenExpiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

  if (existingCreds.length > 0) {
    // Keep existing refresh token if Google didn't return a new one
    const encryptedRefreshToken = tokens.refresh_token
      ? encryptToken(tokens.refresh_token)
      : existingCreds[0].encryptedRefreshToken;

    await db
      .update(credentials)
      .set({
        encryptedRefreshToken,
        encryptedAccessToken,
        tokenExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(credentials.userId, user.id));
  } else {
    const refreshTokenToSave = tokens.refresh_token || 'no_refresh_token_provided';

    await db.insert(credentials).values({
      userId: user.id,
      encryptedRefreshToken: encryptToken(refreshTokenToSave),
      encryptedAccessToken,
      tokenExpiresAt,
    });
  }

  logger.info(`Usuário autenticado com sucesso: ${user.email} (ID: ${user.id})`);
  return user;
}

/**
 * Refreshes and returns a valid Google OAuth access token for a given user.
 */
export async function refreshAccessToken(userId: number): Promise<string> {
  const [cred] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.userId, userId))
    .limit(1);

  if (!cred) {
    throw new Error('Credenciais do Google não encontradas para este usuário.');
  }

  // Check if current cached access token is still valid (with 5 minutes margin)
  const now = new Date();
  if (
    cred.encryptedAccessToken &&
    cred.tokenExpiresAt &&
    cred.tokenExpiresAt.getTime() > now.getTime() + 5 * 60 * 1000
  ) {
    return decryptToken(cred.encryptedAccessToken);
  }

  // Decrypt refresh token and request new access token from Google
  const refreshToken = decryptToken(cred.encryptedRefreshToken);
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  try {
    const { credentials: newTokens } = await oauth2Client.refreshAccessToken();
    const newAccessToken = newTokens.access_token;

    if (!newAccessToken) {
      throw new Error('Falha ao renovar o access token junto ao Google.');
    }

    const encryptedAccessToken = encryptToken(newAccessToken);
    const tokenExpiresAt = newTokens.expiry_date
      ? new Date(newTokens.expiry_date)
      : new Date(Date.now() + 3600 * 1000);

    await db
      .update(credentials)
      .set({
        encryptedAccessToken,
        tokenExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(credentials.userId, userId));

    return newAccessToken;
  } catch (err) {
    logger.error('Erro ao renovar token de acesso do Google:', err);
    throw new Error('Falha na renovação da autorização com o Google. Por favor, refaça o login.');
  }
}

/**
 * Generates an application JWT for session management.
 */
export function generateJWT(user: User | AuthUser): string {
  const payload: AuthUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
  };

  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: '7d',
  });
}

/**
 * Verifies an application JWT and returns the user payload.
 */
export function verifyJWT(token: string): AuthUser {
  try {
    return jwt.verify(token, env.JWT_SECRET) as AuthUser;
  } catch (error) {
    throw new Error('Token JWT inválido ou expirado.');
  }
}
