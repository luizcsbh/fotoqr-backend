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
}

const parseNumber = (val: string | undefined, defaultVal: number): number => {
  if (!val) return defaultVal;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultVal : parsed;
};

export const env: EnvConfig = {
  NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',
  PORT: parseNumber(process.env.PORT, 3001),
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
  CORS_ALLOWED_ORIGINS: (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  BACKEND_PUBLIC_URL: process.env.BACKEND_PUBLIC_URL || 'http://localhost:3001',
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/fotoqr',
  SESSION_SECRET: process.env.SESSION_SECRET || 'dev-session-secret-at-least-32-chars-long-123456',
  JWT_SECRET: process.env.JWT_SECRET || process.env.SESSION_SECRET || 'dev-jwt-secret-at-least-32-chars-long-123456',
  MAX_FILE_SIZE_MB: parseNumber(process.env.MAX_FILE_SIZE_MB, 10),
  MAX_FILES_PER_UPLOAD: parseNumber(process.env.MAX_FILES_PER_UPLOAD, 20),
  MAX_UPLOADS_PER_MINUTE: parseNumber(process.env.MAX_UPLOADS_PER_MINUTE, 10),
};

export default env;
