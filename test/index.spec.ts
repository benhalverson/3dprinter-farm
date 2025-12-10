import { Hono } from 'hono';
import { testClient } from 'hono/testing';
import { describe, expect, it } from 'vitest';

describe('API endpoints', () => {
  it('GET /health', async () => {
    const app = new Hono().get('/health', c => {
      return c.json({ status: 'ok' });
    });
    const res = await testClient(app).health.$get();
    expect(res.status).toBe(200);
  });
});
