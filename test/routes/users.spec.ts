import { describe, expect, test } from 'vitest';
import { testClient } from 'hono/testing';
import { Hono } from 'hono';

describe('User routes', () => {
	test('GET /profile', async() => {
		const user = {
			id: 1,
			email: 'mock@email.com',
			firstName: 'John',
			lastName: 'Doe',
		};
		const app = new Hono().get('/profile', (c) => {
			return c.json(user);
		});
		const res = await testClient(app).profile.$get();
		const json = await res.json();

		expect(res.status).toBe(200);
		expect(json).toEqual(user);
	});
});
