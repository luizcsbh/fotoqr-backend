import { describe, it, expect } from 'vitest';
import { encryptToken, decryptToken } from '../src/utils/encryption.js';
import { generateJWT, verifyJWT, getGoogleAuthUrl } from '../src/services/auth.service.js';
import { sanitizeLog } from '../src/utils/logger.js';

describe('Authentication & Encryption Tests', () => {
  describe('AES-256-GCM Encryption / Decryption', () => {
    it('should encrypt and decrypt a sensitive token accurately', () => {
      const originalToken = 'ya29.a0AfH6SMB_secret_google_refresh_token_123456';
      const encrypted = encryptToken(originalToken);

      expect(encrypted).toBeDefined();
      expect(encrypted).not.toBe(originalToken);

      // Verify format iv:authTag:encrypted
      const parts = encrypted.split(':');
      expect(parts).toHaveLength(3);

      const decrypted = decryptToken(encrypted);
      expect(decrypted).toBe(originalToken);
    });

    it('should generate distinct ciphertexts for identical plaintext due to random IVs', () => {
      const plaintext = 'sample-access-token';
      const cipher1 = encryptToken(plaintext);
      const cipher2 = encryptToken(plaintext);

      expect(cipher1).not.toBe(cipher2);
      expect(decryptToken(cipher1)).toBe(plaintext);
      expect(decryptToken(cipher2)).toBe(plaintext);
    });

    it('should throw an error when attempting to decrypt tampered ciphertext or tags', () => {
      const encrypted = encryptToken('important-secret');
      const parts = encrypted.split(':');
      // Tamper with the ciphertext
      const tampered = `${parts[0]}:${parts[1]}:bad0${parts[2].slice(4)}`;

      expect(() => decryptToken(tampered)).toThrow();
    });

    it('should throw an error for malformed encrypted string', () => {
      expect(() => decryptToken('invalid:format')).toThrow();
      expect(() => decryptToken('')).toThrow();
    });
  });

  describe('JWT Token Generation and Verification', () => {
    const mockUser = {
      id: 42,
      email: 'organizador@evento.com',
      name: 'Carlos Silva',
      avatarUrl: 'https://lh3.googleusercontent.com/photo.jpg',
    };

    it('should generate and verify JWT token successfully', () => {
      const token = generateJWT(mockUser);
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);

      const decoded = verifyJWT(token);
      expect(decoded.id).toBe(mockUser.id);
      expect(decoded.email).toBe(mockUser.email);
      expect(decoded.name).toBe(mockUser.name);
    });

    it('should fail verification for corrupted tokens', () => {
      const token = generateJWT(mockUser);
      const corrupted = token + 'tampered';
      expect(() => verifyJWT(corrupted)).toThrow();
    });
  });

  describe('Google OAuth URL', () => {
    it('should generate an OAuth URL containing required parameters', () => {
      const url = getGoogleAuthUrl('random-csrf-state');
      expect(url).toContain('accounts.google.com');
      expect(url).toContain('access_type=offline');
      expect(url).toContain('prompt=consent');
      expect(url).toContain('state=random-csrf-state');
    });
  });

  describe('Logger Sanitization', () => {
    it('should redact sensitive keys in logs', () => {
      const payload = {
        email: 'user@example.com',
        accessToken: 'ya29.secret',
        refreshToken: '1//0secret',
        password: 'my-password',
        eventTitle: 'Casamento 2026',
        nested: {
          clientSecret: 'secret123',
          publicInfo: 'visible',
        },
      };

      const sanitized = sanitizeLog(payload);

      expect(sanitized.email).toBe('user@example.com');
      expect(sanitized.eventTitle).toBe('Casamento 2026');
      expect(sanitized.accessToken).toBe('[REDACTED]');
      expect(sanitized.refreshToken).toBe('[REDACTED]');
      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.nested.clientSecret).toBe('[REDACTED]');
      expect(sanitized.nested.publicInfo).toBe('visible');
    });

    it('should redact authorization headers starting with Bearer', () => {
      const authHeader = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive';
      expect(sanitizeLog(authHeader)).toBe('Bearer [REDACTED]');
    });
  });
});
