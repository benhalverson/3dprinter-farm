import { testClient } from 'hono/testing';
import { describe, test, expect, beforeEach, vi } from 'vitest'; // Or your preferred test runner
import app from '../../src/index';

import type { Bindings } from '../../src/types';
import { mockEnv } from '../mocks/env';

declare global {
	var env: Bindings;
}

const env = mockEnv();

env.DB = {'test': 'test'} as any;
env.JWT_SECRET = 'secret';
env.RP_NAME = 'RP_NAME';
env.RP_ID = 'RP_ID';

globalThis.env = env;

describe('PassKey Endpoint', () => {
	// Create the test client from the app instance
	const client = testClient(app)
	console.log('env', env);
	console.log('globalThis.env', globalThis.env);

	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('should register a passkey', async () => {
		// Mock the environment variables

		// console.log('client', client.webauthn.register);
		// Call the endpoint using the typed client
		// Notice the type safety for query parameters (if defined in the route)
		// and the direct access via .$get()
		const res = await client.webauthn.register.begin.$post({
			email: 'test@test.com',
		});

		// Assertions
		expect(res.status).toBe(200);
		// expect(await res.json()).toEqual({
		//   query: 'hono',
		//   results: ['result1', 'result2'],
		// })
	});
});
