import { beforeEach, describe, expect, test, vi } from 'vitest';
import { testClient } from 'hono/testing';
import { mockEnv } from '../mocks/env';
import { mockAuth } from '../mocks/auth';
import { mockDrizzle, mockWhere, mockUpdate } from '../mocks/drizzle';
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

		// Mock the update for the profile update endpoint
		const updatedUser = {
			id: 1,
			email: 'test2@test.com',
			firstName: 'Test',
			lastName: 'User',
			shippingAddress: '123 Main St',
			city: 'Testville',
			state: 'TS',
			zipCode: '12345',
			country: 'USA',
			phone: '123-456-7890',
		};
		mockUpdate.mockResolvedValueOnce([updatedUser]);
	});

	test('GET /profile', async () => {
		const res = await client.profile.$get();
		expect(res.status).toBe(200);
	});

	test('POST /profile/:id updates profile email', async () => {
		const profileData = {
			firstName: 'Test',
			lastName: 'User',
			shippingAddress: '123 Main St',
			city: 'Testville',
			state: 'TS',
			zipCode: '12345',
			country: 'USA',
			phone: '123-456-7890',
			email: 'test2@test.com',
		};
		const res = await app.fetch(
			new Request('http://localhost/profile/1', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(profileData),
			}),
			env
		);

		expect(res.status).toBe(200);

		const json = await res.json();
		expect(json).toMatchObject({
			email: 'test2@test.com',
		});
	});
});
