import { describe, it, expect, vi } from 'vitest';
import { Context } from 'hono';
import { upload } from '../../src/controllers/upload';

describe('Upload controller', () => {
	it('should return an error if no file is uploaded', async () => {
		const c = {
			req: {
				parseBody: vi.fn().mockResolvedValue({}),
			}, json: vi.fn()
		} as unknown as Context;

		await upload(c);

		expect(c.json).toHaveBeenCalledWith({ error: 'No file uploaded' }, 400);
	});

	it('should return an error if file upload fails', async() => {
		const c = {
			req: {
				parseBody: vi.fn().mockResolvedValue({ file: { name: 'test' } }),
			}, env: { BUCKET: { put: vi.fn().mockRejectedValue(new Error('test')) } }, json: vi.fn()
		} as unknown as Context;

		await upload(c);

		expect(c.json).toHaveBeenCalledWith({ error: 'Failed to upload file' }, 500);
	});

	it('should upload a file successfully', async () => {
		const file = new File(['file content'], 'test.txt', { type: 'text/plain' });
		const c = {
			req: {
				parseBody: vi.fn().mockResolvedValue({file}),
			},
			env: {
				BUCKET: {
					put: vi.fn().mockResolvedValue(undefined)
				}
			},
			json: vi.fn()
		} as unknown as Context;
		await upload(c);

		expect(c.json).toHaveBeenCalledWith({ messsage: 'File uploaded', key: 'test.txt' });
	});
});
