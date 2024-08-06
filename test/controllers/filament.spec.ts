import { describe, it, expect, vi } from 'vitest';
import { Context } from 'hono';
import { colors } from '../../src/controllers/filament';

describe('colors function', () => {
  it('should return colors if API call succeeds', async () => {
    const mockResponse = {
      filaments: [
        {
          filament: 'PLA',
          hexColor: '#FFFFFF',
          colorTag: 'White',
          profile: 'Standard',
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockResponse),
    });

    const c = {
      env: {
        SLANT_API: 'fake-api-key',
      },
      json: vi.fn(),
    } as unknown as Context;

    await colors(c);

    expect(c.json).toHaveBeenCalledWith(mockResponse);
  });
});
