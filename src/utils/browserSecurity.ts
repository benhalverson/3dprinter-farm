import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import { BROWSER_ORIGINS } from '../config/browserOrigins';

const browserOrigins = new Set<string>(BROWSER_ORIGINS);

/** Rejects unrelated browser origins before handlers, including simple credentialed requests. */
export const browserOriginGuard: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && !browserOrigins.has(origin)) {
    return c.json({ error: 'Origin not allowed' }, 403);
  }
  await next();
};

/** Supports credentialed browser requests and guest cart capability preflights. */
export const browserCors = cors({
  origin: [...BROWSER_ORIGINS],
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Cart-Token'],
});

/** Prevents shared or browser caches from retaining identity and cart responses, including errors. */
export const privateResponseCache: MiddlewareHandler = async (c, next) => {
  await next();
  const privatePath = /^\/(?:auth|api\/auth|profile|users|cart|shipping|payments?|orders|admin|agent)(?:\/|$)/.test(c.req.path);
  if (privatePath || c.req.header('cookie') || c.req.header('authorization') || c.req.header('x-cart-token')) {
    c.header('Cache-Control', 'private, no-store');
    c.header('Pragma', 'no-cache');
    const vary = new Set((c.res.headers.get('Vary') ?? '').split(',').map(value => value.trim()).filter(Boolean));
    for (const name of ['Origin', 'Cookie', 'Authorization', 'X-Cart-Token']) vary.add(name);
    c.header('Vary', [...vary].join(', '));
  }
};
