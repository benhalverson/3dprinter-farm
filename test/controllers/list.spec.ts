import { describe, it, expect, vi } from 'vitest';
import { Context } from 'hono';
import { list, ListResponse } from '../../src/controllers/list';

describe('list function', () => {
  it('should return a list of files', async () => {
    const mockResponse: ListResponse[] = [
      {
        key: 'name.stl',
				stl: 'name.stl',
        size: 18016084,
        version: '7e6ecfad2b96dd228b4162ca07bd5232',
      },

      {
				stl: 'name.stl',
				key: 'name.stl',
        size: 18016084,
        version: '7e6ecfad2b96dd228b4162ca07bd5232',
      },
    ];

    const mockBucket = {
      list: vi.fn().mockResolvedValue({
        objects: mockResponse,
      }),
    };

    const c = {
      env: {
        BUCKET: mockBucket,
        SLANT_API: 'fake-api-key',
      },
      json: vi.fn(),
    } as unknown as Context;

    await list(c);

		expect(mockResponse.length).toBe(2);
    expect(c.json).toHaveBeenCalledWith(
      mockResponse.map((o) => ({
        stl: o.stl,
        size: o.size,
        version: o.version,
      }))
    );
  });
});
