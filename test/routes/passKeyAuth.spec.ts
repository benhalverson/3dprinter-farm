import { testClient } from 'hono/testing';
import { describe, test, expect, beforeEach, vi } from 'vitest';
import app from '../../src/index';
import { mockEnv } from '../mocks/env';
import { mockAuth } from '../mocks/auth';
import { mockInsert, mockDrizzle, mockWhere, mockAll } from '../mocks/drizzle';
import { mockGlobalFetch } from '../mocks/fetch';
import type { Bindings } from '../../src/types';
declare global {
	var env: Bindings;
}

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
globalThis.env = env;

describe('PassKey Endpoint', () => {
	const client = testClient(app, { env });

	beforeEach(() => {
		vi.clearAllMocks();

		mockWhere
			.mockResolvedValueOnce([{ id: 1, email: 'test@example.com' }])
			.mockResolvedValueOnce([{ credentialId: 'credential-id-abc' }]);

		mockAll.mockResolvedValueOnce([{ credentialId: 'credential-id-abc' }]);
	});

	test('should register a passkey', async () => {
		const res = await client.webauthn.register.begin.$post({
			headers: {
				Cookie: `token=mocked.jwt.token`,
			},
			json: {
				email: 'test@example.com',
			},
		});

		expect(res.status).toBe(200);

		const data = (await res.json()) as RegistrationOptionsResponse;
		expect(data).toHaveProperty('challenge');
		expect(data).toHaveProperty('rp');
		expect(data.rp.name).toBe(env.RP_NAME);
	});

	test('should authenticate a passkey', async () => {
		const res = await client.webauthn.auth.begin.$post({
			headers: {
				Cookie: `token=mocked.jwt.token`,
			},
			json: {
				email: 'test@example.com',
			},
		});

		expect(res.status).toBe(200);

		const data = (await res.json()) as AuthenticationOptionsResponse;

		expect(data).toHaveProperty('options');
		expect(data.options).toHaveProperty('challenge');
		expect(Array.isArray(data.options.allowCredentials)).toBe(true);
		expect(data).toHaveProperty('userId');
	});

	test('should finish registration successfully', async () => {
		mockWhere.mockResolvedValueOnce([{ challenge: 'fake-challenge' }]);
		mockInsert.mockResolvedValueOnce(undefined);

		const res = await client.webauthn.register.finish.$post({
			headers: {
				Cookie: `token=mocked.jwt.token`,
			},
			json: {
				id: 'Y3JlZGVudGlhbC1pZC1hYmM',
				rawId: 'Y3JlZGVudGlhbC1yYXctaWQtYWJj',
				response: {
					clientDataJSON: 'client-data-json',
					attestationObject: 'attestation-object',
				},
			},
		});

		expect(res.status).toBe(200);

		const data = (await res.json()) as SuccessResponse;
		expect(data).toEqual({ success: true });
	});
});

interface RegistrationOptionsResponse {
	rp: {
		id: string;
		name: string;
	};
	user: {
		id: string;
		name: string;
		displayName: string;
	};
	challenge: string;
	pubKeyCredParams: any[];
}

interface AuthenticationOptionsResponse {
	options: {
		challenge: string;
		allowCredentials: { id: string; type: 'public-key' }[];
	};
	userId: number;
}

interface SuccessResponse {
	success: true;
}
