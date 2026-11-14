import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

export interface EnvConfig {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  FRONTEND_URL: string;
  CORS_ALLOWED_ORIGINS: string[];
  BACKEND_PUBLIC_URL: string;
  DATABASE_URL: string;
  SESSION_SECRET: string;
  JWT_SECRET: string;
  MAX_FILE_SIZE_MB: number;
  MAX_FILES_PER_UPLOAD: number;
  MAX_UPLOADS_PER_MINUTE: number;
  // Email (SMTP) — optional; falls back to stream transport when absent
  SMTP_HOST: string | undefined;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_USER: string | undefined;
  SMTP_PASS: string | undefined;
  SMTP_FROM: string;
  // Brevo transactional e-mail API key (xkeysib-...) — sends over HTTPS (port 443). Preferred over SMTP
  // because hosts such as Render's free tier block outbound SMTP ports (25/465/587).
  BREVO_API_KEY: string | undefined;
  // WhatsApp Cloud API — optional; falls back to log-only mode when absent
  WHATSAPP_API_TOKEN: string | undefined;
  WHATSAPP_PHONE_NUMBER_ID: string | undefined;
}

const parseNumber = (val: string | undefined, defaultVal: number): number => {
  if (!val) return defaultVal;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultVal : parsed;
};

export const env: EnvConfig = {
  NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',
  PORT: parseNumber(process.env.PORT, 3001),
  FRONTEND_URL: (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, ''),
  CORS_ALLOWED_ORIGINS: (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  BACKEND_PUBLIC_URL: (process.env.BACKEND_PUBLIC_URL || 'http://localhost:3001')
    .split(',')[0]
    .trim()
    .replace(/\/+$/, ''),
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/fotoqr',
  SESSION_SECRET: process.env.SESSION_SECRET || 'dev-session-secret-at-least-32-chars-long-123456',
  JWT_SECRET: process.env.JWT_SECRET || process.env.SESSION_SECRET || 'dev-jwt-secret-at-least-32-chars-long-123456',
  MAX_FILE_SIZE_MB: parseNumber(process.env.MAX_FILE_SIZE_MB, 10),
  MAX_FILES_PER_UPLOAD: parseNumber(process.env.MAX_FILES_PER_UPLOAD, 20),
  MAX_UPLOADS_PER_MINUTE: parseNumber(process.env.MAX_UPLOADS_PER_MINUTE, 60),
  // Email (SMTP)
  SMTP_HOST: process.env.SMTP_HOST || undefined,
  SMTP_PORT: parseNumber(process.env.SMTP_PORT, 587),
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
  SMTP_USER: process.env.SMTP_USER || undefined,
  SMTP_PASS: process.env.SMTP_PASS || undefined,
  SMTP_FROM: process.env.SMTP_FROM || '"FotoQR Eventos" <noreply@fotoqr.app>',
  BREVO_API_KEY: process.env.BREVO_API_KEY || undefined,
  // WhatsApp Cloud API
  WHATSAPP_API_TOKEN: process.env.WHATSAPP_API_TOKEN || undefined,
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || undefined,
};

// In production a missing secret must stop the server: the fallbacks above are public (they are in
// the source code), so anyone could forge a login token — including a platform_admin one.
if (env.NODE_ENV === 'production') {
  const problems: string[] = [];
  for (const key of ['JWT_SECRET', 'SESSION_SECRET'] as const) {
    const value = process.env[key];
    if (!value || value.length < 32 || value.startsWith('dev-')) {
      problems.push(`${key} ausente ou fraco (mínimo 32 caracteres aleatórios)`);
    }
  }
  if (!process.env.DATABASE_URL) problems.push('DATABASE_URL ausente');
  if (problems.length > 0) {
    throw new Error(`Configuração insegura para produção: ${problems.join('; ')}.`);
  }
}

export default env;
