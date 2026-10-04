import { beforeEach, describe, expect, test, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../src/db/schema';
import { validateCartConfiguration } from '../src/modules/cartConfiguration';
import { mockAll } from './mocks/drizzle';
import { mockEnv } from './mocks/env';

const env = mockEnv();
const db = drizzle(env.DB, { schema });
const input = {
  cartId: '10000000-0000-4000-8000-000000000001',
  skuNumber: 'SKU-1',
  quantity: 1,
  color: '#000000',
  filamentType: 'PLA',
  filamentId: '20000000-0000-4000-8000-000000000001',
};
const filament = {
  publicId: input.filamentId,
  profile: 'PLA',
  hexValue: '#000000',
  color: 'Black',
  provider: 'Slant 3D',
  available: true,
};
const cache = vi.fn();
const bindings = { ...env, COLOR_CACHE: { ...env.COLOR_CACHE, get: cache } };

beforeEach(() => {
  mockAll.mockReset().mockResolvedValue([{ filamentType: 'PLA' }]);
  cache
    .mockReset()
    .mockResolvedValue(JSON.stringify({ success: true, data: [filament] }));
  vi.mocked(fetch).mockReset();
});

describe('server-owned cart configuration', () => {
  test('accepts an available Slant color for the product material', async () => {
    await expect(
      validateCartConfiguration(db, bindings, input),
    ).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  test.each([
    { rows: [] },
    { rows: [{ filamentType: 'PETG' }] },
  ])('rejects missing or mismatched products: %j', async ({ rows }) => {
    mockAll.mockResolvedValueOnce(rows);
    await expect(
      validateCartConfiguration(db, bindings, input),
    ).rejects.toMatchObject({ status: 400 });
    expect(cache).not.toHaveBeenCalled();
  });
  test.each([
    { publicId: '30000000-0000-4000-8000-000000000001' },
    { available: false },
    { provider: 'Other' },
    { profile: 'PETG' },
    { hexValue: '#ffffff' },
  ])('rejects invalid selections: %j', async change => {
    cache.mockResolvedValueOnce(
      JSON.stringify({ success: true, data: [{ ...filament, ...change }] }),
    );
    await expect(
      validateCartConfiguration(db, bindings, input),
    ).rejects.toMatchObject({ status: 400 });
  });
  test('checks the provider when the cache is absent', async () => {
    cache.mockResolvedValueOnce(null);
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ success: true, data: [filament] }),
    );
    await validateCartConfiguration(db, bindings, input);
    expect(fetch).toHaveBeenCalledOnce();
  });
  test('accepts the provider color name sent by the storefront', async () => {
    await expect(
      validateCartConfiguration(db, bindings, { ...input, color: 'Black' }),
    ).resolves.toBeUndefined();
  });
  test('does not accept unverified availability after provider failure', async () => {
    cache.mockResolvedValueOnce(null);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(
      validateCartConfiguration(db, bindings, input),
    ).rejects.toMatchObject({ status: 503 });
  });
  test('does not accept malformed cache data', async () => {
    cache.mockResolvedValueOnce('{}');
    await expect(
      validateCartConfiguration(db, bindings, input),
    ).rejects.toMatchObject({ status: 503 });
  });
});
