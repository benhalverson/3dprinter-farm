import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/app';
import * as schema from '../../src/db/schema';
import { mockEnv } from '../mocks/env';

/**
 * Run the mounted app through the real Drizzle adapter with an inert D1 binding.
 * Retired routes must stop before persistence, so an attempted query throws and
 * the binding/storage spies expose effects without starting a database runtime.
 */
const { drizzle: actualDrizzle } =
  await vi.importActual<typeof import('drizzle-orm/d1')>('drizzle-orm/d1');
const prepare = vi.fn(() => {
  throw new Error('Retired routes must not query D1');
});
const batch = vi.fn();
const exec = vi.fn();
const binding = { prepare, batch, exec } as unknown as D1Database;
const db = actualDrizzle(binding, { schema });

beforeEach(() => {
  vi.mocked(drizzle).mockReturnValue(db);
  vi.clearAllMocks();
});

describe('retired printer routes', () => {
  test.each([
    ['POST', '/slice'], ['GET', '/colors'], ['POST', '/estimate'],
    ['POST', '/add-product'], ['POST', '/v2/upload'],
    ['GET', '/v2/uploads'], ['GET', '/v2/uploads/another-users-file'],
    ['GET', '/v2/uploads?limit=10&offset=10'],
  ])('%s %s has no database, storage or provider effects', async (method, path) => {
    const storage = { get: vi.fn(), put: vi.fn(), delete: vi.fn(), list: vi.fn() };
    const env = {
      ...mockEnv(),
      DB: binding,
      BUCKET: storage as unknown as R2Bucket,
      PHOTO_BUCKET: storage as unknown as R2Bucket,
    };
    for (const authenticated of [false, true]) {
      const response = await app.fetch(new Request(`http://localhost${path}`, {
        method,
        headers: authenticated ? { Cookie: 'better-auth.session_token=mock-session-token' } : {},
      }), env);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('404 Not Found');
    }
    // With no database read, even an old stored download URL cannot escape.
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    for (const operation of Object.values(storage))
      expect(operation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
