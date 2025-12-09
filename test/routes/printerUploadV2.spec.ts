import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/index';
import { mockEnv } from '../mocks/env';
import type { Slant3DFileResponse } from '../../src/types';

describe('Printer V2 Upload Routes', () => {
	describe('POST /v2/upload', () => {
		let env: ReturnType<typeof mockEnv>;

		beforeEach(() => {
			env = mockEnv();
			vi.clearAllMocks();
		});

		test('should successfully upload and register STL file', async () => {
			// Mock R2 bucket
			const mockPut = vi.fn().mockResolvedValue(undefined);
			env.BUCKET = {
				put: mockPut,
			} as unknown as R2Bucket;

			// Mock Slant3D V2 API response
			const mockSlant3DResponse: Slant3DFileResponse = {
				success: true,
				message: 'File registered successfully',
				data: {
					publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
					name: 'test-model',
					platformId: 'test-platform-id',
					type: 'stl',
					fileURL: 'https://slant3d.com/files/test-model.stl',
					STLMetrics: {
						x: 100,
						y: 100,
						z: 50,
						weight: 25,
						volume: 500,
						surfaceArea: 1000,
						imageURL: 'https://slant3d.com/images/test-model.png',
					},
					createdAt: '2025-12-09T07:00:00Z',
					updatedAt: '2025-12-09T07:00:00Z',
				},
			};

			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				statusText: 'OK',
				json: async () => mockSlant3DResponse,
			} as Response);

			// Create a mock STL file
			const stlContent = 'solid test\nfacet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid';
			const file = new File([stlContent], 'test-model.stl', { type: 'model/stl' });

			// Create form data
			const formData = new FormData();
			formData.append('file', file);
			formData.append('ownerId', 'BenH');

			const request = new Request('http://localhost/v2/upload', {
				method: 'POST',
				body: formData,
			});

			const response = await app.fetch(request, env);
			const data = await response.json();

			expect(response.status).toBe(201);
			expect(data.success).toBe(true);
			expect(data.message).toBe('File uploaded and registered successfully');
			expect(data.data.local.key).toBe('test-model.stl');
			expect(data.data.local.name).toBe('test-model.stl');
			expect(data.data.local.url).toBe('https://photos.example.com');
			expect(data.data.slant3D.publicFileServiceId).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479');
			expect(data.data.slant3D.name).toBe('test-model');
			expect(data.data.slant3D.fileURL).toBe('https://slant3d.com/files/test-model.stl');
			expect(data.data.slant3D.metrics).toEqual(mockSlant3DResponse.data.STLMetrics);

			// Verify R2 bucket put was called
			expect(mockPut).toHaveBeenCalledWith(
				'test-model.stl',
				expect.any(ReadableStream),
				{
					httpMetadata: { contentType: 'model/stl' },
				}
			);

			// Verify Slant3D API was called
			expect(global.fetch).toHaveBeenCalledWith(
				expect.stringContaining('files/direct-upload'),
				expect.objectContaining({
					method: 'POST',
					headers: expect.objectContaining({
						'Content-Type': 'application/json',
						Authorization: 'Bearer fake-api-key-v2',
					}),
					body: expect.stringContaining('"name":"test-model"'),
				})
			);
		});

		test('should reject non-STL file types', async () => {
			// Create a mock non-STL file
			const file = new File(['not an stl'], 'test.txt', { type: 'text/plain' });

			const formData = new FormData();
			formData.append('file', file);

			const request = new Request('http://localhost/v2/upload', {
				method: 'POST',
				body: formData,
			});

			const response = await app.fetch(request, env);
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.success).toBe(false);
			expect(data.error).toBe('Invalid file type. Only STL files are supported.');
		});

		test('should accept file with .stl extension even without proper MIME type', async () => {
			// Mock R2 bucket
			const mockPut = vi.fn().mockResolvedValue(undefined);
			env.BUCKET = {
				put: mockPut,
			} as unknown as R2Bucket;

			// Mock Slant3D V2 API response
			const mockSlant3DResponse: Slant3DFileResponse = {
				success: true,
				message: 'File registered successfully',
				data: {
					publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
					name: 'test-model',
					platformId: 'test-platform-id',
					type: 'stl',
					fileURL: 'https://slant3d.com/files/test-model.stl',
					createdAt: '2025-12-09T07:00:00Z',
					updatedAt: '2025-12-09T07:00:00Z',
				},
			};

			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				statusText: 'OK',
				json: async () => mockSlant3DResponse,
			} as Response);

			// Create a file with .stl extension but no proper MIME type
			const file = new File(['stl content'], 'test-model.STL', { type: 'application/octet-stream' });

			const formData = new FormData();
			formData.append('file', file);

			const request = new Request('http://localhost/v2/upload', {
				method: 'POST',
				body: formData,
			});

			const response = await app.fetch(request, env);
			const data = await response.json();

			expect(response.status).toBe(201);
			expect(data.success).toBe(true);
			expect(mockPut).toHaveBeenCalled();
		});

		test('should return 400 when no file is uploaded', async () => {
			const formData = new FormData();
			// Don't append any file

			const request = new Request('http://localhost/v2/upload', {
				method: 'POST',
				body: formData,
			});

			const response = await app.fetch(request, env);
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.success).toBe(false);
			expect(data.error).toBe('No file uploaded');
		});

		test('should return 500 when SLANT_PLATFORM_ID is missing', async () => {
			// Remove SLANT_PLATFORM_ID
			env.SLANT_PLATFORM_ID = '';

			const file = new File(['stl content'], 'test-model.stl', { type: 'model/stl' });
			const formData = new FormData();
			formData.append('file', file);

			const request = new Request('http://localhost/v2/upload', {
				method: 'POST',
				body: formData,
			});

			const response = await app.fetch(request, env);
			const data = await response.json();

			expect(response.status).toBe(500);
			expect(data.success).toBe(false);
			expect(data.error).toBe('Missing SLANT_PLATFORM_ID environment variable.');
		});

		test('should handle R2 bucket upload failures', async () => {
			// Mock R2 bucket to throw an error
			const mockPut = vi.fn().mockRejectedValue(new Error('R2 upload failed'));
			env.BUCKET = {
				put: mockPut,
			} as unknown as R2Bucket;

			const file = new File(['stl content'], 'test-model.stl', { type: 'model/stl' });
			const formData = new FormData();
			formData.append('file', file);

			const request = new Request('http://localhost/v2/upload', {
				method: 'POST',
				body: formData,
			});

			const response = await app.fetch(request, env);
			const data = await response.json();

			expect(response.status).toBe(500);
			expect(data.success).toBe(false);
			expect(data.error).toBe('Failed to upload file');
			expect(data.details).toBe('R2 upload failed');
		});

		test('should handle Slant3D API failures with JSON error response', async () => {
			// Mock R2 bucket
			const mockPut = vi.fn().mockResolvedValue(undefined);
			env.BUCKET = {
				put: mockPut,
			} as unknown as R2Bucket;

			// Mock Slant3D V2 API to return error
			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				statusText: 'Bad Request',
				json: async () => ({
					error: 'Invalid file format',
					details: 'File must be a valid STL',
				}),
			} as Response);

			const file = new File(['stl content'], 'test-model.stl', { type: 'model/stl' });
			const formData = new FormData();
			formData.append('file', file);

			const request = new Request('http://localhost/v2/upload', {
				method: 'POST',
				body: formData,
			});

			const response = await app.fetch(request, env);
			const data = await response.json();

			expect(response.status).toBe(500);
			expect(data.success).toBe(false);
			expect(data.error).toBe('Failed to register file with Slant3D V2 API');
			expect(data.details).toEqual({
				error: 'Invalid file format',
				details: 'File must be a valid STL',
			});
		});

		test('should handle Slant3D API failures with text error response', async () => {
			// Mock R2 bucket
			const mockPut = vi.fn().mockResolvedValue(undefined);
			env.BUCKET = {
				put: mockPut,
			} as unknown as R2Bucket;

			// Mock Slant3D V2 API to return text error
			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				statusText: 'Internal Server Error',
				json: async () => {
					throw new Error('Not JSON');
				},
				text: async () => 'Internal server error',
			} as Response);

			const file = new File(['stl content'], 'test-model.stl', { type: 'model/stl' });
			const formData = new FormData();
			formData.append('file', file);

			const request = new Request('http://localhost/v2/upload', {
				method: 'POST',
				body: formData,
			});

			const response = await app.fetch(request, env);
			const data = await response.json();

			expect(response.status).toBe(500);
			expect(data.success).toBe(false);
			expect(data.error).toBe('Failed to register file with Slant3D V2 API');
			expect(data.details).toBe('Internal server error');
		});

		test('should handle network errors when calling Slant3D API', async () => {
			// Mock R2 bucket
			const mockPut = vi.fn().mockResolvedValue(undefined);
			env.BUCKET = {
				put: mockPut,
			} as unknown as R2Bucket;

			// Mock fetch to throw network error
			global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

			const file = new File(['stl content'], 'test-model.stl', { type: 'model/stl' });
			const formData = new FormData();
			formData.append('file', file);

			const request = new Request('http://localhost/v2/upload', {
				method: 'POST',
				body: formData,
			});

			const response = await app.fetch(request, env);
			const data = await response.json();

			expect(response.status).toBe(500);
			expect(data.success).toBe(false);
			expect(data.error).toBe('Failed to upload file');
			expect(data.details).toBe('Network error');
		});

		test('should handle files with dashes in filename', async () => {
			// Mock R2 bucket
			const mockPut = vi.fn().mockResolvedValue(undefined);
			env.BUCKET = {
				put: mockPut,
			} as unknown as R2Bucket;

			// Mock Slant3D V2 API response
			const mockSlant3DResponse: Slant3DFileResponse = {
				success: true,
				message: 'File registered successfully',
				data: {
					publicFileServiceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
					name: 'test-model-v2',
					platformId: 'test-platform-id',
					type: 'stl',
					fileURL: 'https://slant3d.com/files/test-model-v2.stl',
					createdAt: '2025-12-09T07:00:00Z',
					updatedAt: '2025-12-09T07:00:00Z',
				},
			};

			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				statusText: 'OK',
				json: async () => mockSlant3DResponse,
			} as Response);

			const file = new File(['stl content'], 'test-model-v2.stl', { type: 'model/stl' });
			const formData = new FormData();
			formData.append('file', file);

			const request = new Request('http://localhost/v2/upload', {
				method: 'POST',
				body: formData,
			});

			const response = await app.fetch(request, env);
			const data = await response.json();

			expect(response.status).toBe(201);
			expect(data.success).toBe(true);
			expect(data.data.local.key).toBe('test-model-v2.stl');
		});
	});
});
