import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { vi } from 'vitest';
import * as schema from '../../src/db/schema';
import { mockEnv } from '../mocks/env';
import { createProviderBoundary } from '../../tools/admin-demo/providers';
import worker from '../../tools/admin-demo/worker';

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => state.db }));
vi.mock(
  '../../lib/auth',
  async () => import('../../tools/admin-demo/auth-fixture'),
);

/** Explicit object-storage mock: bytes and metadata live only in a Map. */
function bucket() {
  const objects = new Map<
    string,
    { bytes: Uint8Array; options: R2PutOptions }
  >();
  const read = (key: string) => {
    const value = objects.get(key);
    return value
      ? {
          key,
          size: value.bytes.length,
          etag: key,
          httpEtag: `"${key}"`,
          uploaded: new Date(),
          customMetadata: value.options.customMetadata,
          httpMetadata: value.options.httpMetadata,
          body: new Blob([value.bytes]).stream(),
          arrayBuffer: async () => value.bytes.slice().buffer,
          writeHttpMetadata: (headers: Headers) => {
            if (value.options.httpMetadata?.contentType)
              headers.set(
                'content-type',
                value.options.httpMetadata.contentType,
              );
          },
        }
      : null;
  };
  return {
    put: vi.fn(
      async (
        key: string,
        value: ArrayBuffer | Uint8Array | ReadableStream,
        options: R2PutOptions = {},
      ) => {
        const bytes = new Uint8Array(await new Response(value).arrayBuffer());
        objects.set(key, { bytes, options });
        return read(key);
      },
    ),
    get: vi.fn(async (key: string) => read(key)),
    head: vi.fn(async (key: string) => read(key)),
    delete: vi.fn(async (key: string | string[]) => {
      for (const item of Array.isArray(key) ? key : [key]) objects.delete(item);
    }),
  } as unknown as R2Bucket;
}

/** Production Hono handlers called in-process; all provider/R2/auth boundaries mocked. */
export async function createMockDemoRuntime() {
  const client = createClient({ url: 'file::memory:' });
  const db = drizzle(client, { schema });
  state.db = db;
  await migrate(db, { migrationsFolder: './.generated/quote-test-migrations' });
  const providers = createProviderBoundary();
  const url = new URL('http://localhost:8790');
  providers.setOrigin(url.origin);
  const photoBucket = bucket();
  const env = {
    ...mockEnv(),
    PHOTO_BUCKET: photoBucket,
    BUCKET: bucket(),
    SQUARE_MERCHANT_ID: 'merchant-demo',
    SQUARE_LOCATION_ID: 'location-demo',
    SLANT_PLATFORM_ID: 'platform-demo',
    SLANT_API_V2_BASE_URL: 'https://slant3dapi.com/v2/api/',
    ENCRYPTION_PASSPHRASE: 'local-fixture-only',
  };
  const context = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
  const request: typeof fetch = async (input, init) => {
    const incoming = new Request(input, init);
    return new URL(incoming.url).origin === url.origin
      ? worker.fetch(incoming, env, context)
      : providers.providerFetch(incoming);
  };
  vi.stubGlobal('fetch', vi.fn(request));
  const seeded = await request(new URL('/__fixture/bootstrap', url), {
    method: 'POST',
    headers: { 'x-demo-fixture-token': 'lulu-local-demo' },
  });
  if (!seeded.ok) throw new Error(await seeded.text());
  await db
    .insert(schema.organizationTable)
    .values({
      id: 'org_shared_catalog',
      name: 'Staff',
      slug: 'staff',
      createdAt: new Date(),
    });
  await db
    .insert(schema.memberTable)
    .values(
      ['admin', 'member'].map(role => ({
        id: `demo-${role}`,
        userId: `demo-${role}`,
        organizationId: 'org_shared_catalog',
        role,
        createdAt: new Date(),
      })),
    );
  return {
    url,
    providers,
    photoBucket,
    request,
    async close() {
      client.close();
      vi.unstubAllGlobals();
    },
  };
}
