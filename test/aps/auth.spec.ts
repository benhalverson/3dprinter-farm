import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('APS Auth', () => {
	let getAPSToken: typeof import('../../src/aps/auth').getAPSToken;

	const mockEnv: Env = {
		APS_CLIENT_ID: 'test-client-id',
		APS_CLIENT_SECRET: 'test-client-secret',
	} as Env;

	beforeEach(async () => {
		vi.clearAllMocks();
		// Reset modules to clear the cached token
		vi.resetModules();
		// Re-import the module to get a fresh instance
		const authModule = await import('../../src/aps/auth');
		getAPSToken = authModule.getAPSToken;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('should fetch and return an access token', async () => {
		const mockResponse = {
			access_token: 'test-access-token',
			token_type: 'Bearer',
			expires_in: 3600,
		};

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockResponse,
		});

		const token = await getAPSToken(mockEnv);

		expect(token).toBe('test-access-token');
		expect(global.fetch).toHaveBeenCalledWith(
			'https://developer.api.autodesk.com/auth/v1/token',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					Authorization: expect.stringContaining('Basic'),
					'Content-Type': 'application/x-www-form-urlencoded',
				}),
				body: 'grant_type=client_credentials&scope=data:read data:write bucket:read bucket:create',
			})
		);
	});

	it('should cache the token and reuse it', async () => {
		const mockResponse = {
			access_token: 'cached-token',
			token_type: 'Bearer',
			expires_in: 3600,
		};

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockResponse,
		});

		// First call
		const token1 = await getAPSToken(mockEnv);
		expect(token1).toBe('cached-token');

		// Second call should use cached token
		const token2 = await getAPSToken(mockEnv);
		expect(token2).toBe('cached-token');

		// Fetch should only be called once
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('should throw an error if fetch fails', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			statusText: 'Unauthorized',
		});

		await expect(getAPSToken(mockEnv)).rejects.toThrow(
			'Failed to fetch APS token: 401 Unauthorized'
		);
	});

	it('should encode credentials correctly in Basic auth', async () => {
		const mockResponse = {
			access_token: 'test-token',
			token_type: 'Bearer',
			expires_in: 3600,
		};

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockResponse,
		});

		await getAPSToken(mockEnv);

		const expectedAuth = btoa('test-client-id:test-client-secret');
		expect(global.fetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: `Basic ${expectedAuth}`,
				}),
			})
		);
	});
});
