import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
}

/**
 * Global error handling middleware.
 * Ensures internal system details or credentials are never leaked to clients.
 */
export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Log sanitized error details internally
  logger.error('Erro na requisição:', err, {
    method: req.method,
    path: req.path,
    ip: req.ip,
  });

  // Handle Multer specific errors
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({
        success: false,
        error: `O arquivo excede o limite máximo permitido de ${env.MAX_FILE_SIZE_MB}MB.`,
      });
      return;
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      res.status(400).json({
        success: false,
        error: `Limite de arquivos excedido. O máximo permitido por envio é de ${env.MAX_FILES_PER_UPLOAD} fotos.`,
      });
      return;
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      res.status(400).json({
        success: false,
        error: 'Campo de arquivo inesperado no formulário de upload.',
      });
      return;
    }

    res.status(400).json({
      success: false,
      error: `Erro no upload de arquivo: ${err.message}`,
    });
    return;
  }

  // Handle known client errors with custom statusCode
  let statusCode = err.statusCode;
  if (!statusCode) {
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('não encontrado') || msg.includes('not found')) {
      statusCode = 404;
    } else if (
      msg.includes('formato de arquivo') ||
      msg.includes('inválido') ||
      msg.includes('obrigatório') ||
      msg.includes('excede') ||
      msg.includes('limite')
    ) {
      statusCode = 400;
    } else {
      statusCode = 500;
    }
  }

  // Friendly user-facing message in Portuguese
  let message = 'Ocorreu um erro interno no servidor. Por favor, tente novamente mais tarde.';
  if (statusCode < 500 && err.message) {
    message = err.message;
  }

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(env.NODE_ENV !== 'production' && { details: err.message }),
  });
}
