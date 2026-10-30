import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { db } from '../config/database.js';
import { users, User } from '../models/schema.js';
import { env } from '../config/env.js';
import { AuthUser } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

export interface PasswordRegistration {
  name: string;
  email: string;
  password: string;
}

export class AuthServiceError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'AuthServiceError';
  }
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

function validateEmail(email: unknown): asserts email is string {
  if (
    typeof email !== 'string' ||
    !email.trim() ||
    email.trim().length > 255 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  ) {
    throw new AuthServiceError('Informe um e-mail válido.', 400);
  }
}

function validatePassword(password: string): void {
  if (
    typeof password !== 'string' ||
    password.length < 8 ||
    Buffer.byteLength(password, 'utf8') > 72
  ) {
    throw new AuthServiceError('A senha deve ter pelo menos 8 caracteres e no máximo 72 bytes.', 400);
  }
}

function validateEmailAndPassword(email: string, password: string): void {
  validateEmail(email);
  validatePassword(password);
}

export async function registerWithPassword({
  name,
  email,
  password,
}: PasswordRegistration): Promise<User> {
  const normalizedEmail = typeof email === 'string' ? normalizeEmail(email) : '';
  const normalizedName = typeof name === 'string' ? name.trim() : '';

  validateEmailAndPassword(normalizedEmail, password);
  if (normalizedName.length < 2 || normalizedName.length > 255) {
    throw new AuthServiceError('Informe um nome entre 2 e 255 caracteres.', 400);
  }

  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(
      sql`lower(${users.email}) = ${normalizedEmail}`,
      sql`${users.passwordHash} IS NOT NULL`
    ))
    .limit(1);

  if (existingUser) {
    throw new AuthServiceError('Este e-mail já possui uma conta. Entre com o método usado no cadastro.', 409);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const [user] = await db
      .insert(users)
      .values({
        email: normalizedEmail,
        name: normalizedName,
        passwordHash,
      })
      .returning();
    return user;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    ) {
      throw new AuthServiceError('Já existe uma conta com este e-mail.', 409);
    }
    throw error;
  }
}

export async function loginWithPassword(email: string, password: string): Promise<User> {
  const normalizedEmail = typeof email === 'string' ? normalizeEmail(email) : '';
  validateEmailAndPassword(normalizedEmail, password);

  const [user] = await db
    .select()
    .from(users)
    .where(and(sql`lower(${users.email}) = ${normalizedEmail}`, sql`${users.passwordHash} IS NOT NULL`))
    .limit(1);

  if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new AuthServiceError('E-mail ou senha inválidos.', 401);
  }

  return user;
}

export async function updateProfile(userId: number, name: string): Promise<User> {
  const normalizedName = typeof name === 'string' ? name.trim() : '';
  if (normalizedName.length < 2 || normalizedName.length > 255) {
    throw new AuthServiceError('Informe um nome entre 2 e 255 caracteres.', 400);
  }

  const [user] = await db
    .update(users)
    .set({ name: normalizedName, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();

  if (!user) throw new AuthServiceError('Usuário não encontrado.', 404);
  return user;
}

export async function changePassword(
  userId: number,
  currentPassword: string,
  newPassword: string
): Promise<User> {
  if (typeof currentPassword !== 'string' || !currentPassword) {
    throw new AuthServiceError('Informe sua senha atual.', 400);
  }
  validatePassword(newPassword);

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AuthServiceError('Usuário não encontrado.', 404);
  if (!user.passwordHash || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new AuthServiceError('A senha atual está incorreta.', 400);
  }
  if (await bcrypt.compare(newPassword, user.passwordHash)) {
    throw new AuthServiceError('A nova senha deve ser diferente da senha atual.', 400);
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  const [updatedUser] = await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  if (!updatedUser) throw new AuthServiceError('Usuário não encontrado.', 404);
  return updatedUser;
}

export async function updateAvatar(userId: number, image: Buffer): Promise<User> {
  let processedBuffer: Buffer;
  try {
    processedBuffer = await sharp(image, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize(512, 512, { fit: 'cover', position: 'attention' })
      .webp({ quality: 82 })
      .toBuffer();
  } catch (err) {
    logger.error('Não foi possível processar a imagem enviada para o avatar:', err);
    throw new AuthServiceError('Não foi possível processar a imagem enviada.', 400);
  }

  const avatarUrl = `/api/users/${userId}/avatar`;
  const [user] = await db
    .update(users)
    .set({
      avatarUrl,
      avatarData: processedBuffer,
      avatarMimeType: 'image/webp',
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();

  if (!user) throw new AuthServiceError('Usuário não encontrado.', 404);

  return user;
}

export async function getUserAvatar(userId: number): Promise<{ data: Buffer; mimeType: string } | null> {
  const [user] = await db
    .select({
      avatarData: users.avatarData,
      avatarMimeType: users.avatarMimeType,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || !user.avatarData) {
    return null;
  }

  return {
    data: user.avatarData,
    mimeType: user.avatarMimeType || 'image/webp',
  };
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
