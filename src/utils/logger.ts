import { env } from '../config/env.js';

const SENSITIVE_KEYS = [
  'token',
  'refreshtoken',
  'accesstoken',
  'secret',
  'password',
  'authorization',
  'cookie',
  'encrypted',
  'servicekey',
  'encryptionkey',
  'credentials',
];

/**
 * Sanitizes any data structure to remove sensitive keys, tokens, or credentials before logging.
 */
export function sanitizeLog(data: any): any {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    // Check for authorization header patterns or raw tokens
    if (data.toLowerCase().startsWith('bearer ')) {
      return 'Bearer [REDACTED]';
    }
    return data;
  }

  if (typeof data !== 'object') {
    return data;
  }

  if (data instanceof Error) {
    return {
      name: data.name,
      message: data.message,
      stack: env.NODE_ENV === 'production' ? undefined : data.stack,
    };
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeLog(item));
  }

  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_KEYS.some((sensitive) => lowerKey.includes(sensitive));

    if (isSensitive) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeLog(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

export const logger = {
  info(message: string, context?: any): void {
    const timestamp = new Date().toISOString();
    if (context !== undefined) {
      console.log(`[${timestamp}] [INFO] ${message}`, JSON.stringify(sanitizeLog(context)));
    } else {
      console.log(`[${timestamp}] [INFO] ${message}`);
    }
  },

  warn(message: string, context?: any): void {
    const timestamp = new Date().toISOString();
    if (context !== undefined) {
      console.warn(`[${timestamp}] [WARN] ${message}`, JSON.stringify(sanitizeLog(context)));
    } else {
      console.warn(`[${timestamp}] [WARN] ${message}`);
    }
  },

  error(message: string, error?: any, context?: any): void {
    const timestamp = new Date().toISOString();
    const payload: Record<string, any> = {};
    if (error) {
      payload.error = sanitizeLog(error);
    }
    if (context) {
      payload.context = sanitizeLog(context);
    }

    if (Object.keys(payload).length > 0) {
      console.error(`[${timestamp}] [ERROR] ${message}`, JSON.stringify(payload));
    } else {
      console.error(`[${timestamp}] [ERROR] ${message}`);
    }
  },

  debug(message: string, context?: any): void {
    if (env.NODE_ENV === 'production') return;
    const timestamp = new Date().toISOString();
    if (context !== undefined) {
      console.debug(`[${timestamp}] [DEBUG] ${message}`, JSON.stringify(sanitizeLog(context)));
    } else {
      console.debug(`[${timestamp}] [DEBUG] ${message}`);
    }
  },
};

export default logger;
