import crypto from 'crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Derives a consistent 32-byte Buffer key from the configured encryption key.
 */
function getKey(): Buffer {
  const rawKey = env.TOKEN_ENCRYPTION_KEY;
  // If it's already a 64-character hex string representing 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }
  // Otherwise derive a deterministic 32-byte key using SHA-256
  return crypto.createHash('sha256').update(rawKey).digest();
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Output format: `iv:authTag:encryptedData` (hex encoded).
 */
export function encryptToken(token: string): string {
  if (!token) {
    throw new Error('O token a ser criptografado não pode ser vazio.');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts an encrypted token in format `iv:authTag:encryptedData`.
 */
export function decryptToken(encrypted: string): string {
  if (!encrypted) {
    throw new Error('O texto criptografado não pode ser vazio.');
  }

  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Formato do token criptografado inválido.');
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Tamanho de IV ou AuthTag inválido.');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
