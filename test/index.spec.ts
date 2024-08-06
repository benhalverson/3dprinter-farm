import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testClient } from 'hono/testing';
import { Hono } from 'hono';
import { upload } from '../src/controllers/upload';

describe('API endpoints', () => {
	it('GET /health', async () => {
		const app = new Hono().get('/health', (c) => {
			return c.json({ status: 'ok' });

		});
		const res = await testClient(app).health.$get();
		expect(res.status).toBe(200);
	});

});
