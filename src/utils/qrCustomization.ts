/**
 * QR code / table card customization saved per event, so the owner sees the same
 * design on every device. Mirrors `StoredQRCustomization` in the frontend.
 */
export interface QRCustomization {
  eventType: string;
  fgColor: string;
  bgColor: string;
  title: string;
  subtitle: string;
  instructions: string;
  wifiName: string;
  wifiPassword: string;
  frameStyle: string;
  iconChoice: string;
  presetId?: string;
}

export class QRCustomizationError extends Error {
  readonly statusCode = 400;
}

const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const OPTION_ID = /^[a-z0-9_-]{1,40}$/i;

function color(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !COLOR.test(value)) {
    throw new QRCustomizationError(`Cor inválida em "${key}". Use o formato #RRGGBB.`);
  }
  return value;
}

function optionId(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !OPTION_ID.test(value)) {
    throw new QRCustomizationError(`Valor inválido em "${key}".`);
  }
  return value;
}

function text(input: Record<string, unknown>, key: string, max: number): string {
  const value = input[key] ?? '';
  if (typeof value !== 'string') {
    throw new QRCustomizationError(`O campo "${key}" deve ser um texto.`);
  }
  if (value.length > max) {
    throw new QRCustomizationError(`O campo "${key}" deve ter no máximo ${max} caracteres.`);
  }
  return value.trim();
}

/**
 * Validates a customization sent by the client and keeps only the known fields,
 * so arbitrary JSON never reaches the database.
 */
export function sanitizeQRCustomization(input: unknown): QRCustomization {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new QRCustomizationError('Personalização do QR Code inválida.');
  }
  const data = input as Record<string, unknown>;

  const sanitized: QRCustomization = {
    eventType: optionId(data, 'eventType'),
    fgColor: color(data, 'fgColor'),
    bgColor: color(data, 'bgColor'),
    title: text(data, 'title', 255),
    subtitle: text(data, 'subtitle', 255),
    instructions: text(data, 'instructions', 1000),
    wifiName: text(data, 'wifiName', 64),
    wifiPassword: text(data, 'wifiPassword', 128),
    frameStyle: optionId(data, 'frameStyle'),
    iconChoice: optionId(data, 'iconChoice'),
  };
  if (data.presetId !== undefined && data.presetId !== null && data.presetId !== '') {
    sanitized.presetId = optionId(data, 'presetId');
  }
  return sanitized;
}
