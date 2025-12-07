import type { MiddlewareHandler } from 'hono';

export const rateLimit = (options: {
  windowSeconds: number;
  maxRequests: number;
  keyPrefix?: string;
}): MiddlewareHandler => {
  return async (c, next) => {
    const ip = c.req.header('cf-connecting-ip') || 'unknown';
    const path = c.req.path;
    const key = `${options.keyPrefix ?? 'rl'}:${path}:${ip}`;
    const kv = c.env.RATE_LIMIT_KV as KVNamespace;
    const currentCount = await kv.get(key);
    const count = currentCount ? parseInt(currentCount, 10) : 0;

    if (count >= options.maxRequests) {
      return c.json({ error: 'Too many requests' }, 429);
    }

    await kv.put(key, (count + 1).toString(), {
      expirationTtl: options.windowSeconds,
    });

    return next();
  };
};
