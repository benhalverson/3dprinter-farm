import { describe, it, expect, vi } from 'vitest';
import { Context } from 'hono';
import { slice } from '../../src/controllers/slice';

const BASE_URL = 'https://example.com/';

describe('slice function', () => {
  it('should return result if API call succeeds', async () => {
    const mockResponse = {
      message: 'File sliced successfully',
      data: {
        price: 100,
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockResponse),
    });

    const c = {
      req: {
        json: vi.fn().mockResolvedValue({ fileURL: 'https://example.com/file.stl' }),
      },
      env: {
        SLANT_API: 'fake-api-key',
      },
      json: vi.fn(),
    } as unknown as Context;

    await slice(c);

    expect(c.json).toHaveBeenCalledWith(mockResponse);
  });

});
