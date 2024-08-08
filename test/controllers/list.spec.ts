import { describe, it, expect, vi } from 'vitest';
import { Context } from 'hono';
import { list } from '../../src/controllers/list';

describe('list function', () => {
  it('should return a list of files', async () => {
    const mockResponse = [
      {
        stl: 'name.stl',
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

    expect(c.json).toHaveBeenCalledWith(
      mockResponse.map((o) => ({
        stl: o.stl,
        size: o.size,
        version: o.version,
      }))
    );
  });
});
