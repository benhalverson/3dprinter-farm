import { beforeEach, describe, expect, test, vi } from 'vitest';
import { testClient } from 'hono/testing';
import { Hono } from 'hono';
import { ProfileDataSchema } from '../../src/db/schema';
import { mockEnv } from '../mocks/env';
import { mockAuth } from '../mocks/auth';
import { mockDrizzle, mockWhere } from '../mocks/drizzle';
import { mockGlobalFetch } from '../mocks/fetch';
import app from '../../src';

vi.mock('@simplewebauthn/server', async () => {
	const actual = await vi.importActual<typeof import('@simplewebauthn/server')>(
		'@simplewebauthn/server'
	);
	return {
		...actual,
		generateRegistrationOptions: vi.fn(async () => ({
			rp: { id: 'example.com', name: 'ExampleApp' },
			user: {
				id: 'user-id',
				name: 'test@example.com',
				displayName: 'Test User',
			},
			challenge: 'fake-challenge',
			pubKeyCredParams: [],
		})),
		generateAuthenticationOptions: vi.fn(async () => ({
			challenge: 'fake-challenge',
			allowCredentials: [],
		})),
		verifyRegistrationResponse: vi.fn(async () => ({
			verified: true,
			registrationInfo: {
				credential: {
					id: 'credential-id-abc',
					publicKey: 'fake-public-key',
					counter: 0,
				},
			},
		})),
	};
});

mockAuth();
mockDrizzle();
mockGlobalFetch();

const env = mockEnv();

describe('Profile Endpoints', () => {
	const client = testClient(app, { env });
	beforeEach(() => {
		vi.clearAllMocks();

		mockWhere
			.mockResolvedValueOnce([{ id: 1, email: 'test@example.com' }])
			.mockResolvedValueOnce([{ credentialId: 'credential-id-abc' }]);
	});

	test('GET /profile', async () => {
		const res = await client.profile.$get();
		console.log('res:', res);
		expect(res.status).toBe(200);
	});
});
