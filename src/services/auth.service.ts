import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users, User } from '../models/schema.js';
import { env } from '../config/env.js';
import { AuthUser } from '../middleware/auth.js';

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

function validateEmailAndPassword(email: string, password: string): void {
  if (
    typeof email !== 'string' ||
    !email ||
    email.length > 255 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new AuthServiceError('Informe um e-mail válido.', 400);
  }

  if (
    typeof password !== 'string' ||
    password.length < 8 ||
    Buffer.byteLength(password, 'utf8') > 72
  ) {
    throw new AuthServiceError('A senha deve ter pelo menos 8 caracteres e no máximo 72 bytes.', 400);
  }
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
    .where(and(eq(users.email, normalizedEmail), sql`${users.passwordHash} IS NOT NULL`))
    .limit(1);

  if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new AuthServiceError('E-mail ou senha inválidos.', 401);
  }

  return user;
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
