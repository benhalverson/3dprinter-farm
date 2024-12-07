import { describe, it, expect, vi } from 'vitest';
import { Context } from 'hono';
import { colors } from '../../src/controllers/filament';

describe('colors function', () => {
  it('should return filtered and sorted colors for PETG when queried', async () => {
    const mockResponse = {
      filaments: [
        {
          filament: 'PETG WHITE',
          hexColor: 'f6efef',
          colorTag: 'petgWhite',
          profile: 'PETG',
        },
        {
          filament: 'PETG BLACK',
          hexColor: '000000',
          colorTag: 'petgBlack',
          profile: 'PETG',
        },
        {
          filament: 'PLA BLACK',
          hexColor: '000000',
          colorTag: 'black',
          profile: 'PLA',
        },
        {
          filament: 'PLA GRAY',
          hexColor: '666666',
          colorTag: 'gray',
          profile: 'PLA',
        },
      ],
    };

    // Mock the global fetch API
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(mockResponse),
    });

    // Mock the KV store
    const kvGet = vi.fn().mockResolvedValue(null); // Simulate no cached response
    const kvPut = vi.fn(); // Mock KV put

    // Mock the Hono Context
    const c = {
      req: {
        query: vi.fn().mockReturnValue('PETG'), // Simulating a query for PETG
      },
      env: {
        SLANT_API: 'fake-api-key',
        COLOR_CACHE: { get: kvGet, put: kvPut }, // Mocked KV methods
      },
      json: vi.fn(),
    } as unknown as Context;

    // Call the function
    await colors(c);

    const expectedResult = [
      {
        filament: 'PETG WHITE',
        hexColor: 'f6efef',
        colorTag: 'petgWhite',
      },
      {
        filament: 'PETG BLACK',
        hexColor: '000000',
        colorTag: 'petgBlack',
      },
    ];

    // Assertions
    const expectedCacheKey = '3dprinter-web-api-COLOR_CACHE:PETG'; // Updated key to include query
    expect(c.json).toHaveBeenCalledWith(expectedResult);
    expect(kvGet).toHaveBeenCalledWith(expectedCacheKey); // Verify cache key lookup
    expect(kvPut).toHaveBeenCalledWith(
      expectedCacheKey,
      JSON.stringify(expectedResult),
      { expirationTtl: 604800 }
    ); // Verify cache storage
  });
});
