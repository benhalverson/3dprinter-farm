import { describe, test, expect, beforeEach, vi } from 'vitest';
import app from '../../src/index';
import { mockEnv } from '../mocks/env';
import { mockWhere, mockAll, mockInsert, mockUpdate } from '../mocks/drizzle';

// This cookie value matches what your mockAuth is expecting
const fakeSignedCookie = 'token=s.mocked.signed.cookie';

describe('Product Routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('GET /products returns list of products', async () => {
		mockAll.mockResolvedValueOnce([{ id: 1, name: 'Test Product' }]);

		const request = new Request('http://localhost/products', {
			method: 'GET',
			headers: {
				Cookie: fakeSignedCookie,
			},
		});

		const res = await app.fetch(request, mockEnv());

		expect(res.status).toBe(200);
		const data = await res.json() as { id: number; name: string }[];
		expect(Array.isArray(data)).toBe(true);
		expect(data[0]).toMatchObject({ id: 1 });
	});

	test('GET /product/:id returns single product', async () => {
		mockWhere.mockResolvedValueOnce([{ id: 1, name: 'Test Product' }]);

		const request = new Request('http://localhost/product/1', {
			method: 'GET',
			headers: {
				Cookie: fakeSignedCookie,
			},
		});

		const res = await app.fetch(request, mockEnv());

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data).toMatchObject({ id: 1 });
	});

	test('GET /product/:id returns 404 if not found', async () => {
		mockWhere.mockResolvedValueOnce([]);

		const request = new Request('http://localhost/product/999', {
			method: 'GET',
			headers: {
				Cookie: fakeSignedCookie,
			},
		});

		const res = await app.fetch(request, mockEnv());

		expect(res.status).toBe(404);
		const data = await res.json();
		expect(data.error).toMatch(/not found/i);
	});

	test('POST /add-product adds a product', async () => {
		(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				data: { price: 10 },
			}),
		});

		mockInsert.mockResolvedValueOnce([{ id: 1 }]);

		const request = new Request('http://localhost/add-product', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Cookie: fakeSignedCookie,
			},
			body: JSON.stringify({
				name: 'New Product',
				description: 'desc',
				stl: 'url/to.stl',
				price: 15,
				image: 'url/to/image.jpg',
				filamentType: 'PLA',
				color: '#ffffff',
			}),
		});

		const res = await app.fetch(request, mockEnv());

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(Array.isArray(data)).toBe(true);
		expect(data[0]).toHaveProperty('id');
	});

	test('POST /add-product handles slicer API failure', async () => {
		(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: false,
			json: async () => ({
				message: 'slicer failed',
			}),
		});

		const request = new Request('http://localhost/add-product', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Cookie: fakeSignedCookie,
			},
			body: JSON.stringify({
				name: 'Bad Product',
				description: 'desc',
				stl: 'url/to.stl',
				image: 'url/to/image.jpg',
				price: 15,
				filamentType: 'PLA',
				color: '#ffffff',
			}),
		});

		const res = await app.fetch(request, mockEnv());

		expect(res.status).toBe(500);
		const data = await res.json();
		expect(data.error).toBe('Failed to slice file');
	});

	test('PUT /update-product updates a product', async () => {
		mockUpdate.mockResolvedValueOnce({ success: true });

		const request = new Request('http://localhost/update-product', {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				Cookie: fakeSignedCookie,
			},
			body: JSON.stringify({
				id: 1,
				name: 'Updated Product',
				description: 'Updated desc',
				price: 20,
				image: 'url/to/image.jpg',
				filamentType: 'PLA',
				color: '#000000',
				stl: 'url/to/updated.stl',
				skuNumber: 'SKU123',
			}),
		});

		const res = await app.fetch(request, mockEnv());

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.success).toBe(true);
	});

	test('PUT /update-product validation error returns 400', async () => {
		const request = new Request('http://localhost/update-product', {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				Cookie: fakeSignedCookie,
			},
			body: JSON.stringify({}),
		});

		const res = await app.fetch(request, mockEnv());

		expect(res.status).toBe(400);
		const data = await res.json();
		expect(data.error).toBe('Validation error');
	});
});
