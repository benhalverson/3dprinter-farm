import { describe, it, expect, vi } from 'vitest';
import { Context } from 'hono';
import { colors } from '../../src/controllers/filament';

describe('colors function', () => {
  it('should return filtered and sorted colors if API call succeeds without a query', async () => {
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
        {
          filament: 'PLA WHITE',
          hexColor: 'ffffff',
          colorTag: 'white',
          profile: 'PLA',
        },
        {
          filament: 'PLA YELLOW',
          hexColor: 'f5c211',
          colorTag: 'yellow',
          profile: 'PLA',
        },
        {
          filament: 'PLA RED',
          hexColor: 'f91010',
          colorTag: 'red',
          profile: 'PLA',
        },
        {
          filament: 'PLA GOLD',
          hexColor: 'd5b510',
          colorTag: 'gold',
          profile: 'PLA',
        },
        {
          filament: 'PLA LUNAR REGOLITH',
          hexColor: '7d7e7e',
          colorTag: 'lunarRegolith',
          profile: 'PLA',
        },
        {
          filament: 'PLA MATTE BLACK',
          hexColor: '000000',
          colorTag: 'matteBlack',
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
        query: vi.fn().mockReturnValue(undefined), // Simulating no query parameter
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
      {
        filament: 'PLA BLACK',
        hexColor: '000000',
        colorTag: 'black',
      },
      {
        filament: 'PLA GRAY',
        hexColor: '666666',
        colorTag: 'gray',
      },
      {
        filament: 'PLA WHITE',
        hexColor: 'ffffff',
        colorTag: 'white',
      },
      {
        filament: 'PLA YELLOW',
        hexColor: 'f5c211',
        colorTag: 'yellow',
      },
      {
        filament: 'PLA RED',
        hexColor: 'f91010',
        colorTag: 'red',
      },
      {
        filament: 'PLA GOLD',
        hexColor: 'd5b510',
        colorTag: 'gold',
      },
      {
        filament: 'PLA LUNAR REGOLITH',
        hexColor: '7d7e7e',
        colorTag: 'lunarRegolith',
      },
      {
        filament: 'PLA MATTE BLACK',
        hexColor: '000000',
        colorTag: 'matteBlack',
      },
    ];

    // Assertions
    expect(c.json).toHaveBeenCalledWith(expectedResult);
    expect(kvGet).toHaveBeenCalledWith('3dprinter-web-api-COLOR_CACHE'); // Verify cache key lookup
    expect(kvPut).toHaveBeenCalledWith(
      '3dprinter-web-api-COLOR_CACHE',
      JSON.stringify(expectedResult),
      { expirationTtl: 604800 }
    ); // Verify cache storage
  });
});
