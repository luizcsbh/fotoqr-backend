import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomUUID, randomBytes } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { db } from '../config/database.js';
import { users, User, passwordResetTokens } from '../models/schema.js';
import { env } from '../config/env.js';
import { AuthUser } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { deliveryService } from './delivery.service.js';

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
    role: (user as any).role || 'user',
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

/**
 * Requests a password reset: generates a secure token, stores it hashed, sends email.
 * Always returns void to prevent email enumeration.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  validateEmail(email);
  const normalizedEmail = normalizeEmail(email);

  const [user] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(sql`lower(${users.email}) = ${normalizedEmail}`, sql`${users.passwordHash} IS NOT NULL`))
    .limit(1);

  // Always succeed silently (anti-enumeration)
  if (!user) return;

  // Invalidate any previous tokens for this user
  await db
    .delete(passwordResetTokens)
    .where(eq(passwordResetTokens.userId, user.id));

  // Generate a 48-byte secure random token
  const rawToken = randomBytes(48).toString('hex');
  const tokenHash = await bcrypt.hash(rawToken, 10);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  const resetUrl = `${env.FRONTEND_URL}/redefinir-senha?token=${rawToken}&email=${encodeURIComponent(user.email)}`;

  // Send email
  try {
    const transporter = deliveryService.getMailTransporter();
    await transporter.sendMail({
      from: env.SMTP_FROM,
      to: user.email,
      subject: 'Redefinição de Senha — FotoQR',
      html: generatePasswordResetEmailHtml(user.name, resetUrl),
    });
  } catch (err) {
    logger.error('Falha ao enviar e-mail de recuperação de senha:', err);
    throw new AuthServiceError(
      'Não foi possível enviar o e-mail de recuperação. Verifique a configuração SMTP no servidor.',
      500
    );
  }
}

function generatePasswordResetEmailHtml(name: string, resetUrl: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>Redefinição de Senha — FotoQR</title></head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f1f5f9; margin: 0; padding: 24px; color: #1e293b;">
      <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 560px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
        <tr>
          <td style="background: linear-gradient(135deg, #4f46e5, #10b981); padding: 32px 24px; text-align: center;">
            <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 700;">🔐 Redefinição de Senha</h1>
            <p style="color: #c7d2fe; margin: 8px 0 0 0; font-size: 14px;">FotoQR Eventos</p>
          </td>
        </tr>
        <tr>
          <td style="padding: 32px 24px;">
            <p style="font-size: 16px; margin: 0 0 12px;">Olá, <strong>${name}</strong>!</p>
            <p style="font-size: 15px; color: #475569; line-height: 1.6; margin: 0 0 24px;">
              Recebemos uma solicitação para redefinir a senha da sua conta no FotoQR.<br>
              Clique no botão abaixo para criar uma nova senha:
            </p>
            <div style="text-align: center; margin: 28px 0;">
              <a href="${resetUrl}" target="_blank" style="background-color: #4f46e5; color: #ffffff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 15px; display: inline-block;">
                Redefinir minha senha
              </a>
            </div>
            <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 14px 16px; border-radius: 6px; margin: 20px 0;">
              <p style="margin: 0; font-size: 13px; color: #92400e;">
                ⏱ Este link expira em <strong>1 hora</strong>.<br>
                Se você não solicitou a redefinição, ignore este e-mail com segurança.
              </p>
            </div>
            <p style="font-size: 12px; color: #94a3b8; margin: 20px 0 0;">
              Ou copie e cole este link no seu navegador:<br>
              <span style="word-break: break-all; color: #4f46e5;">${resetUrl}</span>
            </p>
          </td>
        </tr>
        <tr>
          <td style="background-color: #f8fafc; padding: 16px 24px; text-align: center; border-top: 1px solid #e2e8f0;">
            <p style="font-size: 12px; color: #94a3b8; margin: 0;">
              Enviado com segurança pela plataforma <strong>FotoQR</strong>.
            </p>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

/**
 * Validates the reset token and sets a new password.
 */
export async function resetPasswordWithToken(
  email: string,
  rawToken: string,
  newPassword: string
): Promise<void> {
  validateEmail(email);
  validatePassword(newPassword);
  const normalizedEmail = normalizeEmail(email);

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(sql`lower(${users.email}) = ${normalizedEmail}`, sql`${users.passwordHash} IS NOT NULL`))
    .limit(1);

  if (!user) {
    throw new AuthServiceError('Token inválido ou expirado.', 400);
  }

  // Find valid, unused token
  const [tokenRecord] = await db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.userId, user.id),
        gt(passwordResetTokens.expiresAt, new Date()),
        sql`${passwordResetTokens.usedAt} IS NULL`
      )
    )
    .limit(1);

  if (!tokenRecord) {
    throw new AuthServiceError('Token inválido ou expirado.', 400);
  }

  // Compare the raw token against the stored hash
  const isValid = await bcrypt.compare(rawToken, tokenRecord.tokenHash);
  if (!isValid) {
    throw new AuthServiceError('Token inválido ou expirado.', 400);
  }

  // Mark token as used
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetTokens.id, tokenRecord.id));

  // Set new password
  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  // Invalidate remaining tokens
  await db
    .delete(passwordResetTokens)
    .where(eq(passwordResetTokens.userId, user.id));
}
