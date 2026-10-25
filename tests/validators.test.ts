import { describe, it, expect } from 'vitest';
import { validateMimeType, validateFileSize, validateEventInput } from '../src/utils/validators.js';
import { generateQRCode } from '../src/utils/qrcode.js';

describe('Validators & Utilities', () => {
  describe('validateMimeType', () => {
    it('should validate JPEG magic bytes correctly', async () => {
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
      const result = await validateMimeType(jpegBuffer);
      expect(result.valid).toBe(true);
      expect(result.mime).toBe('image/jpeg');
    });

    it('should validate PNG magic bytes correctly', async () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
      const result = await validateMimeType(pngBuffer);
      expect(result.valid).toBe(true);
      expect(result.mime).toBe('image/png');
    });

    it('should validate WEBP magic bytes correctly', async () => {
      const webpBuffer = Buffer.from([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x00, 0x00, 0x00, 0x00, // size
        0x57, 0x45, 0x42, 0x50, // WEBP
      ]);
      const result = await validateMimeType(webpBuffer);
      expect(result.valid).toBe(true);
      expect(result.mime).toBe('image/webp');
    });

    it('should reject non-image buffers', async () => {
      const textBuffer = Buffer.from('Este e um arquivo de texto qualquer');
      const result = await validateMimeType(textBuffer);
      expect(result.valid).toBe(false);
    });

    it('should reject empty or very short buffers', async () => {
      const emptyBuffer = Buffer.from([]);
      const result = await validateMimeType(emptyBuffer);
      expect(result.valid).toBe(false);
    });
  });

  describe('validateFileSize', () => {
    it('should allow files within the size limit', () => {
      const fiveMb = 5 * 1024 * 1024;
      expect(validateFileSize(fiveMb, 10)).toBe(true);
    });

    it('should reject files exceeding the size limit', () => {
      const elevenMb = 11 * 1024 * 1024;
      expect(validateFileSize(elevenMb, 10)).toBe(false);
    });

    it('should reject invalid or zero file sizes', () => {
      expect(validateFileSize(0)).toBe(false);
      expect(validateFileSize(-100)).toBe(false);
    });
  });

  describe('validateEventInput', () => {
    it('should accept valid event data', () => {
      const result = validateEventInput({
        title: 'Casamento Mariana e Felipe',
        description: 'Compartilhe suas melhores fotos deste dia especial!',
        eventDate: '2026-11-20T18:00:00Z',
        storageMode: 'fallback',
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject empty title', () => {
      const result = validateEventInput({
        title: '   ',
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('título');
    });

    it('should reject title shorter than 2 characters', () => {
      const result = validateEventInput({
        title: 'A',
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('pelo menos 2');
    });

    it('should reject invalid storage mode', () => {
      const result = validateEventInput({
        title: 'Aniversário 30 anos',
        storageMode: 'invalid_mode',
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('armazenamento inválido');
    });

    it('should reject invalid date string', () => {
      const result = validateEventInput({
        title: 'Formatura 2026',
        eventDate: 'data-invalida',
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('data do evento é inválida');
    });
  });

  describe('generateQRCode', () => {
    it('should generate a base64 png data URL', async () => {
      const url = 'https://fotoqr.app/e/test-event-uuid-123';
      const qrDataUrl = await generateQRCode(url);
      expect(qrDataUrl).toBeDefined();
      expect(qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    });

    it('should throw error on empty input', async () => {
      await expect(generateQRCode('')).rejects.toThrow();
    });
  });
});
