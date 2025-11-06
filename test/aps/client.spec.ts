import { describe, it, expect, beforeEach, vi } from 'vitest';
import { apsFetch } from '../../src/aps/client';
import * as auth from '../../src/aps/auth';

describe('APS Client', () => {
	const mockEnv: Env = {
		APS_CLIENT_ID: 'test-client-id',
		APS_CLIENT_SECRET: 'test-client-secret',
	} as Env;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should fetch data from APS API with authentication', async () => {
		const mockToken = 'test-access-token';
		const mockData = { id: '123', name: 'Test Bucket' };

		vi.spyOn(auth, 'getAPSToken').mockResolvedValue(mockToken);

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockData,
		});

		const result = await apsFetch<typeof mockData>(
			mockEnv,
			'https://developer.api.autodesk.com/oss/v2/buckets'
		);

		expect(result).toEqual(mockData);
		expect(auth.getAPSToken).toHaveBeenCalledWith(mockEnv);
		expect(global.fetch).toHaveBeenCalledWith(
			'https://developer.api.autodesk.com/oss/v2/buckets',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: `Bearer ${mockToken}`,
					'Content-Type': 'application/json',
				}),
			})
		);
	});

	it('should pass custom headers along with auth headers', async () => {
		const mockToken = 'test-access-token';
		const mockData = { success: true };

		vi.spyOn(auth, 'getAPSToken').mockResolvedValue(mockToken);

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockData,
		});

		await apsFetch<typeof mockData>(mockEnv, 'https://test.api.com/endpoint', {
			headers: {
				'X-Custom-Header': 'custom-value',
			},
		});

		expect(global.fetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: `Bearer ${mockToken}`,
					'Content-Type': 'application/json',
					'X-Custom-Header': 'custom-value',
				}),
			})
		);
	});

	it('should support different HTTP methods', async () => {
		const mockToken = 'test-access-token';
		const mockData = { created: true };

		vi.spyOn(auth, 'getAPSToken').mockResolvedValue(mockToken);

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockData,
		});

		await apsFetch<typeof mockData>(mockEnv, 'https://test.api.com/endpoint', {
			method: 'POST',
			body: JSON.stringify({ name: 'New Item' }),
		});

		expect(global.fetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ name: 'New Item' }),
			})
		);
	});

	it('should throw an error with details when API request fails', async () => {
		const mockToken = 'test-access-token';
		const errorText = 'Invalid bucket name';

		vi.spyOn(auth, 'getAPSToken').mockResolvedValue(mockToken);

		global.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 400,
			statusText: 'Bad Request',
			text: async () => errorText,
		});

		await expect(
			apsFetch(mockEnv, 'https://test.api.com/endpoint')
		).rejects.toThrow('APS API Error: 400 Bad Request - Invalid bucket name');
	});

	it('should handle JSON parsing errors gracefully', async () => {
		const mockToken = 'test-access-token';

		vi.spyOn(auth, 'getAPSToken').mockResolvedValue(mockToken);

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => {
				throw new Error('Invalid JSON');
			},
		});

		await expect(apsFetch(mockEnv, 'https://test.api.com/endpoint')).rejects.toThrow(
			'Invalid JSON'
		);
	});
});
