import { describe, it, expect, vi } from 'vitest';
import { Context } from 'hono';
import { estimateOrder } from '../../src/controllers/estimate-order';

const BASE_URL = 'https://example.com/';

describe('estimateOrder function', () => {
  it('should return error if API call fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn().mockResolvedValue({
        error: 'Invalid API key',
        details: {
          error: 'Unauthorized access',
        },
      }),
    });

    const c = {
      req: {
        json: vi.fn().mockResolvedValue({ orderData: 'some data' }),
      },
      env: {
        SLANT_API: 'fake-api-key',
      },
      json: vi.fn(),
    } as unknown as Context;

    await estimateOrder(c);

    expect(c.json).toHaveBeenCalledWith({
      error: 'Failed to estimate order',
      details: {
        error: 'Invalid API key',
        details: {
          error: 'Unauthorized access',
        },
      },
    }, 500);
  });

  it('should return order estimate if API call succeeds', async () => {
    const mockResponse = {
      estimate: {
        cost: 100,
        currency: 'USD',
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockResponse),
    });

    const c = {
      req: {
        json: vi.fn().mockResolvedValue({ orderData: 'some data' }),
      },
      env: {
        SLANT_API: 'fake-api-key',
      },
      json: vi.fn(),
    } as unknown as Context;

    await estimateOrder(c);

    expect(c.json).toHaveBeenCalledWith(mockResponse);
  });

});
