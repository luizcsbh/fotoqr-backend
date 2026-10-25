import { describe, it, expect } from 'vitest';
import {
  generateJWT,
  verifyJWT,
  loginWithPassword,
  registerWithPassword,
} from '../src/services/auth.service.js';
import { sanitizeLog } from '../src/utils/logger.js';

describe('Authentication Tests', () => {
  describe('JWT Token Generation and Verification', () => {
    const mockUser = {
      id: 42,
      email: 'organizador@evento.com',
      name: 'Carlos Silva',
      avatarUrl: null,
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

  describe('E-mail and password validation', () => {
    it('should reject malformed e-mails before accessing the database', async () => {
      await expect(
        registerWithPassword({ name: 'Ana Silva', email: 'invalid', password: 'senha-segura' })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('should reject passwords shorter than 8 characters', async () => {
      await expect(loginWithPassword('ana@example.com', '1234567')).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it('should reject passwords longer than bcrypt supports', async () => {
      await expect(
        registerWithPassword({
          name: 'Ana Silva',
          email: 'ana@example.com',
          password: 'a'.repeat(73),
        })
      ).rejects.toMatchObject({ statusCode: 400 });
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
