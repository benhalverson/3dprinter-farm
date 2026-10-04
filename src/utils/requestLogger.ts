import type { MiddlewareHandler } from 'hono';
import { logger } from 'hono/logger';

// Reset tokens may appear in callback paths or in Better Auth's query fallback.
export const requestLogger: MiddlewareHandler = (c, next) =>
  c.req.path.startsWith('/agent/') ||
  c.req.path.startsWith('/api/auth/reset-password') ||
  c.req.path === '/api/auth/request-password-reset'
    ? next()
    : logger()(c, next);
