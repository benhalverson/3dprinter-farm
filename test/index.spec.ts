import { describe, expect, it } from 'vitest';
import app from '../src/index';
import { mockEnv } from './mocks/env';

type OpenApiDocument = {
  paths?: Record<string, unknown>;
};

describe('API endpoints', () => {
  it('GET /health', async () => {
    const res = await app.fetch(
      new Request('http://example.com/health'),
      mockEnv(),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });

  it('GET /docs serves the API reference', async () => {
    const res = await app.fetch(
      new Request('http://example.com/docs'),
      mockEnv(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('GET /open-api documents ecommerce checkout and order operations', async () => {
    const res = await app.fetch(
      new Request('http://example.com/open-api'),
      mockEnv(),
    );

    expect(res.status).toBe(200);

    const spec = (await res.json()) as OpenApiDocument;
    expect(spec.paths).toBeDefined();
    expect(Object.keys(spec.paths ?? {})).toEqual(
      expect.arrayContaining([
        '/cart/{cartId}/checkout',
        '/cart/{cartId}/payment-intent',
        '/webhook/stripe',
        '/orders',
        '/orders/{id}',
        '/webhook/slant3d',
        '/admin/catalog/readiness',
        '/admin/orders/{id}/cancel-refund',
        '/admin/orders/{id}/reconcile',
        '/admin/orders/{id}/resend-notification',
      ]),
    );
  });
});
