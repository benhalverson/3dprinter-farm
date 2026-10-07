import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import * as schema from '../../src/db/schema';
import { mockEnv } from '../mocks/env';
const state = vi.hoisted(() => ({ db: undefined as unknown, userId: 'owner' }));
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => state.db }));
vi.mock('../../lib/auth', () => ({
  createAuth: () => ({
    api: {
      getSession: async () => ({ user: { id: state.userId }, session: {} }),
    },
  }),
}));
vi.mock('../../src/modules/productPhotoBytes', () => ({
  MAX_PHOTO_BYTES: 5000000,
  boundedBytes: vi.fn(),
  validatePhotoBytes: vi.fn(),
}));
import drafts from '../../src/routes/productDrafts';
const id = '11223344-1234-4123-8123-123456789abc';
let client: ReturnType<typeof createClient>;
let db: ReturnType<typeof drizzle<typeof schema>>;
function begin(body: object = { requestKey: id, target: { kind: 'new' } }) {
  return drafts.request(
    '/',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    mockEnv(),
  );
}
beforeEach(async () => {
  state.userId = 'owner';
  client = createClient({ url: ':memory:' });
  db = drizzle(client, { schema });
  state.db = db;
  await migrate(db, { migrationsFolder: '.generated/quote-test-migrations' });
  await db.insert(schema.users).values([
    { id: 'owner', name: 'Owner', email: 'owner@example.test' },
    { id: 'other', name: 'Other', email: 'other@example.test' },
  ]);
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
      ['owner', 'other'].map(userId => ({
        id: userId,
        userId,
        organizationId: 'org_shared_catalog',
        role: 'admin',
        createdAt: new Date(),
      })),
    );
});
afterEach(() => client.close());
test('client-retained identity recovers creation after reload without duplicating or overwriting edited state', async () => {
  expect((await begin()).status).toBe(201);
  const recovered = await drafts.request(
    `/by-request-key/${id}`,
    {},
    mockEnv(),
  );
  expect(recovered.status).toBe(200);
  const recoveredId = (await recovered.json()).id;
  expect(recoveredId).toBeTruthy();
  await db
    .update(schema.productDrafts)
    .set({
      revision: 2,
      state: { answers: { name: 'Edited' }, pendingQuestions: [], history: [] },
    })
    .where(eq(schema.productDrafts.id, recoveredId));
  const replay = await begin();
  expect(
    (
      await begin({
        requestKey: id,
        target: { kind: 'new' },
        state: {
          answers: { name: 'Original' },
          pendingQuestions: [],
          history: [],
        },
      })
    ).status,
  ).toBe(409);
  expect(await replay.json()).toMatchObject({
    id: recoveredId,
    revision: 2,
    state: { answers: { name: 'Edited' } },
  });
  expect(await db.select().from(schema.productDrafts)).toHaveLength(1);
});
test('concurrent create retries retain one draft', async () => {
  const responses = await Promise.all([begin(), begin()]);
  expect(responses.map(r => r.status)).toEqual([201, 201]);
  expect(await db.select().from(schema.productDrafts)).toHaveLength(1);
});
test('request-key lookup is owned and same-key changed inputs or discarded drafts conflict', async () => {
  await begin();
  state.userId = 'other';
  expect(
    (await drafts.request(`/by-request-key/${id}`, {}, mockEnv())).status,
  ).toBe(404);
  expect((await begin()).status).toBe(201);
  expect(await db.select().from(schema.productDrafts)).toHaveLength(2);
  state.userId = 'owner';
  expect(
    (
      await begin({
        requestKey: id,
        target: { kind: 'existing', productId: 123 },
      })
    ).status,
  ).toBe(409);
  await db.update(schema.productDrafts).set({ status: 'discarded' });
  expect((await begin()).status).toBe(409);
  expect(
    (await drafts.request(`/by-request-key/${id}`, {}, mockEnv())).status,
  ).toBe(410);
});
