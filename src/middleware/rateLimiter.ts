import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

/**
 * Rate limiter specifically for public photo uploads to prevent flooding or abuse.
 * Uses MAX_UPLOADS_PER_MINUTE from env.
 */
export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: env.MAX_UPLOADS_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Limite de uploads atingido. Por favor, aguarde um minuto antes de enviar mais fotos.',
  },
});

/**
 * General API rate limiter for standard endpoints.
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // 300 requests per 15 minutes per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Muitas requisições originadas deste IP. Por favor, tente novamente mais tarde.',
  },
});
