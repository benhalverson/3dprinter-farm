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

// Mock crypto functions
vi.mock('../../src/utils/crypto', async () => {
	const actual = await vi.importActual<typeof import('../../src/utils/crypto')>('../../src/utils/crypto');
	return {
		...actual,
		decryptField: vi.fn().mockImplementation(async (encryptedData: string) => {
			// Return mock decrypted data based on the field
			if (encryptedData === 'encrypted-test') return 'Test';
			if (encryptedData === 'encrypted-user') return 'User';
			if (encryptedData === 'encrypted-123-main-st') return '123 Main St';
			if (encryptedData === 'encrypted-testville') return 'Testville';
			if (encryptedData === 'encrypted-ts') return 'TS';
			if (encryptedData === 'encrypted-12345') return '12345';
			if (encryptedData === 'encrypted-usa') return 'USA';
			if (encryptedData === 'encrypted-123-456-7890') return '123-456-7890';
			return 'decrypted-value';
		}),
		encryptField: vi.fn().mockImplementation(async (plaintext: string) => {
			return `encrypted-${plaintext.toLowerCase().replace(/\s+/g, '-')}`;
		}),
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
			.mockResolvedValueOnce([{
				id: 1,
				email: 'test@example.com',
				firstName: 'encrypted-test',
				lastName: 'encrypted-user',
				shippingAddress: 'encrypted-123-main-st',
				city: 'encrypted-testville',
				state: 'encrypted-ts',
				zipCode: 'encrypted-12345',
				country: 'encrypted-usa',
				phone: 'encrypted-123-456-7890'
			}])
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
		const res = await app.fetch(
			new Request('http://localhost/profile', {
				method: 'GET',
				headers: {
					Cookie: 'token=s.mocked.signed.cookie',
				},
			}),
			env
		);
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
