import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/app';
import * as schema from '../../src/db/schema';
import { mockBetterAuth } from '../mocks/auth';
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

// These bodies satisfy the retired handlers' input shapes at 68d4bc9. Empty
// POSTs would only prove that an accidentally restored handler rejects input.
const stl = 'https://uploads.example.com/user_123/retired.stl';
const retiredRequests = [
  { method: 'POST', path: '/slice', json: { fileURL: stl } },
  { method: 'GET', path: '/colors' },
  { method: 'GET', path: '/colors?filamentType=PLA' },
  {
    method: 'POST',
    path: '/estimate',
    json: {
      email: 'test@example.com',
      phone: '5555550100',
      name: 'Test User',
      orderNumber: 'retired-test',
      filename: 'retired.stl',
      fileURL: stl,
      bill_to_street_1: '123 Test St',
      bill_to_city: 'Test City',
      bill_to_state: 'CA',
      bill_to_zip: '90210',
      bill_to_country_as_iso: 'US',
      bill_to_is_US_residential: 'true',
      ship_to_name: 'Test User',
      ship_to_street_1: '123 Test St',
      ship_to_city: 'Test City',
      ship_to_state: 'CA',
      ship_to_zip: '90210',
      ship_to_country_as_iso: 'US',
      ship_to_is_US_residential: 'true',
      order_item_name: 'Retired test',
      order_quantity: '1',
      order_sku: 'retired-test',
    },
  },
  {
    method: 'POST',
    path: '/add-product',
    json: {
      name: 'Retired test',
      description: 'Legacy request fixture',
      stl,
      markupPercentage: 25,
      inPersonPrice: 10,
      filamentType: 'PLA',
      color: 'Black',
      image: 'https://photos.example.com/retired.png',
    },
  },
  { method: 'POST', path: '/v2/upload', multipart: true },
  { method: 'GET', path: '/v2/uploads' },
  { method: 'GET', path: '/v2/uploads/another-users-file' },
  { method: 'GET', path: '/v2/uploads?limit=10&offset=10' },
];

describe.each([
  'anonymous',
  'user',
  'admin',
])('retired printer routes: %s', role => {
  test.each(
    retiredRequests,
  )('$method $path has no persistence or provider effects', async request => {
    const storage = {
      get: vi.fn(),
      getWithMetadata: vi.fn(),
      head: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    };
    const env = {
      ...mockEnv(),
      DB: binding,
      BUCKET: storage as unknown as R2Bucket,
      PHOTO_BUCKET: storage as unknown as R2Bucket,
      COLOR_CACHE: storage as unknown as KVNamespace,
      RATE_LIMIT_KV: storage as unknown as KVNamespace,
    };
    mockBetterAuth.getSession.mockResolvedValue(
      role === 'anonymous'
        ? null
        : {
            session: { id: 'session', expiresAt: new Date(Date.now() + 60000) },
            user: {
              id: 'user_123',
              email: 'test@example.com',
              name: 'Test User',
              role,
            },
          },
    );
    const headers = new Headers();
    if (role !== 'anonymous')
      headers.set('Cookie', 'better-auth.session_token=mock-session-token');
    let body: BodyInit | undefined;
    if (request.multipart) {
      const form = new FormData();
      form.set(
        'file',
        new File(['solid fixture\nendsolid fixture\n'], 'retired.stl', {
          type: 'model/stl',
        }),
      );
      body = form;
    } else if (request.json) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(request.json);
    }
    const response = await app.fetch(
      new Request(`http://localhost${request.path}`, {
        method: request.method,
        headers,
        body,
      }),
      env,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('404 Not Found');
    // With no database read, even an old stored download URL cannot escape.
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    for (const operation of Object.values(storage))
      expect(operation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

test('health and readiness accept V2 configuration without a V1 credential', async () => {
  const env = mockEnv();
  expect(env).not.toHaveProperty('SLANT_API');
  expect((await app.request('/health', {}, env)).status).toBe(200);
  const ready = await app.request('/ready', {}, env);
  expect(ready.status).toBe(200);
  expect(await ready.json()).toMatchObject({ features: { slant: 'ready' } });
  expect(prepare).not.toHaveBeenCalled();
  expect(batch).not.toHaveBeenCalled();
  expect(exec).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
