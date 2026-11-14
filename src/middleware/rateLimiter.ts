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

const GALLERY_PATH = /^\/api\/events\/[^/?]+\/gallery(\?|$)/;

/** Public gallery (guests and Telão): generous, it is read-only and polled. */
export const galleryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Muitas atualizações da galeria. Aguarde alguns segundos.' },
});

/** Guest messages on the wall: a few per minute per network is plenty for a party. */
export const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Muitos recados enviados em sequência. Aguarde um minuto e tente de novo.' },
});

/**
 * General API rate limiter for standard endpoints.
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // 300 requests per 15 minutes per IP
  // The public gallery has its own limiter: a Telão refreshes it every few seconds, usually on the
  // same venue Wi-Fi (same IP) as the guests, and must not eat their budget
  skip: (req) => req.method === 'GET' && GALLERY_PATH.test(req.originalUrl),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Muitas requisições originadas deste IP. Por favor, tente novamente mais tarde.',
  },
});

/**
 * Sign-up tells whether an e-mail already has an account (unavoidable without e-mail confirmation),
 * so it gets its own, tighter budget: testing a list of e-mails becomes impractically slow.
 */
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Muitas tentativas de cadastro a partir desta rede. Tente novamente em uma hora.',
  },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Muitas tentativas de autenticação. Aguarde alguns minutos e tente novamente.',
  },
});
