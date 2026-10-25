import { env } from '../config/env.js';

export interface MimeValidationResult {
  valid: boolean;
  mime: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates real MIME type of an image buffer using file magic numbers.
 */
export async function validateMimeType(buffer: Buffer): Promise<MimeValidationResult> {
  if (!buffer || buffer.length < 12) {
    return { valid: false, mime: 'unknown' };
  }

  // Check JPEG (FF D8 FF)
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { valid: true, mime: 'image/jpeg' };
  }

  // Check PNG (89 50 4E 47 0D 0A 1A 0A)
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { valid: true, mime: 'image/png' };
  }

  // Check WEBP (RIFF .... WEBP)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { valid: true, mime: 'image/webp' };
  }

  // Check GIF (GIF87a or GIF89a)
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return { valid: true, mime: 'image/gif' };
  }

  // Check HEIC / HEIF (....ftypheic or mif1)
  if (
    buffer.length >= 12 &&
    buffer[4] === 0x66 && // f
    buffer[5] === 0x74 && // t
    buffer[6] === 0x79 && // y
    buffer[7] === 0x70    // p
  ) {
    const brand = buffer.toString('ascii', 8, 12);
    if (['heic', 'heix', 'hevc', 'heim', 'mif1', 'msf1'].includes(brand)) {
      return { valid: true, mime: 'image/heic' };
    }
  }

  return { valid: false, mime: 'application/octet-stream' };
}

/**
 * Validates that file size is within acceptable limits.
 */
export function validateFileSize(size: number, maxMb: number = env.MAX_FILE_SIZE_MB): boolean {
  if (typeof size !== 'number' || size <= 0) {
    return false;
  }
  const maxBytes = maxMb * 1024 * 1024;
  return size <= maxBytes;
}

/**
 * Validates input data for creating or updating an event.
 */
export function validateEventInput(data: any): ValidationResult {
  const errors: string[] = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Dados do evento são obrigatórios.'] };
  }

  // Title validation
  if (!data.title || typeof data.title !== 'string' || data.title.trim().length === 0) {
    errors.push('O título do evento é obrigatório.');
  } else if (data.title.trim().length < 2) {
    errors.push('O título do evento deve ter pelo menos 2 caracteres.');
  } else if (data.title.trim().length > 255) {
    errors.push('O título do evento deve ter no máximo 255 caracteres.');
  }

  // Description validation (optional)
  if (data.description !== undefined && data.description !== null) {
    if (typeof data.description !== 'string') {
      errors.push('A descrição deve ser um texto válido.');
    } else if (data.description.length > 2000) {
      errors.push('A descrição deve ter no máximo 2000 caracteres.');
    }
  }

  // Event date / Start date / End date validation (optional)
  const eventDate = data.eventDate || data.event_date;
  if (eventDate !== undefined && eventDate !== null && eventDate !== '') {
    const parsedDate = new Date(eventDate);
    if (isNaN(parsedDate.getTime())) {
      errors.push('A data do evento é inválida.');
    }
  }

  const rawStart = data.startDate || data.start_date;
  let parsedStart: Date | null = null;
  if (rawStart !== undefined && rawStart !== null && rawStart !== '') {
    parsedStart = new Date(rawStart);
    if (isNaN(parsedStart.getTime())) {
      errors.push('A data/hora de início do evento é inválida.');
    }
  }

  const rawEnd = data.endDate || data.end_date;
  let parsedEnd: Date | null = null;
  if (rawEnd !== undefined && rawEnd !== null && rawEnd !== '') {
    parsedEnd = new Date(rawEnd);
    if (isNaN(parsedEnd.getTime())) {
      errors.push('A data/hora de término do evento é inválida.');
    }
  }

  if (parsedStart && parsedEnd && parsedEnd < parsedStart) {
    errors.push('A data/hora de término não pode ser anterior à data/hora de início.');
  }

  // Storage mode validation (optional, defaults to 'google_photos')
  const storageMode = data.storageMode || data.storage_mode;
  if (storageMode !== undefined && storageMode !== null) {
    if (!['google_photos', 'fallback'].includes(storageMode)) {
      errors.push('Modo de armazenamento inválido. Deve ser "google_photos" ou "fallback".');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
