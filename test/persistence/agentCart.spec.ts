import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import * as schema from '../../src/db/schema';
import { createCart, requireCartAccess } from '../../src/modules/cartOwnership';
import {
  addCartLine,
  setCartLineQuantity,
} from '../../src/modules/cartMutations';
import { commerceTools, authoritativeCart } from '../../src/shopping/commerce';
import { runInference } from '../../src/shopping/inference';
import type { RunInput } from '../../src/shopping/contracts';
import type { WorkerEnv } from '../../src/factory';
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
import routes from '../../src/routes/shoppingCart';
let client: ReturnType<typeof createClient>;
let db: WorkerEnv['Variables']['db'];
let cartId: string;
let input: RunInput;
const filamentId = '11223344-1234-4123-8123-123456789abc';
const sessionId = '22334455-1234-4123-8123-123456789abc';
const color = {
  publicId: filamentId,
  profile: 'PLA',
  color: 'Red',
  hexValue: '#ff0000',
  provider: 'Slant 3D',
  available: true,
};
const env = {
  ...mockEnv(),
  COLOR_CACHE: {
    get: vi.fn(async () => JSON.stringify({ success: true, data: [color] })),
  } as unknown as KVNamespace,
};
const options = { name: 'selection_options', arguments: { productId: 1 } };
const add = {
  name: 'cart_add',
  arguments: { productId: 1, filamentId, quantity: 2 },
};
const caller = { userId: 'owner' };
const selection = () => ({
  cartId,
  skuNumber: 'SKU',
  filamentType: 'PLA',
  color: '#ff0000',
  filamentId,
  quantity: 1,
});
beforeEach(async () => {
  state.userId = 'owner';
  client = createClient({ url: ':memory:' });
  const actual = drizzle(client, { schema });
  state.db = actual;
  db = actual as unknown as typeof db;
  await migrate(actual, {
    migrationsFolder: '.generated/quote-test-migrations',
  });
  await db.insert(schema.users).values([
    { id: 'owner', name: 'Owner', email: 'owner@test.example' },
    { id: 'other', name: 'Other', email: 'other@test.example' },
  ]);
  await db
    .insert(schema.productsTable)
    .values({
      id: 1,
      name: 'Bracket',
      description: 'A bracket',
      price: 12,
      stl: 'file',
      skuNumber: 'SKU',
      filamentType: 'PLA',
    });
  cartId = (await createCart(db, 'owner')).cartId;
  input = {
    runId: crypto.randomUUID(),
    uiRevision: 1,
    message: 'Add two red brackets',
    context: [],
    cart: { id: cartId, revision: 0 },
    selection: { productId: 1, quantity: 1 },
  };
  vi.mocked(env.COLOR_CACHE.get)
    .mockReset()
    .mockResolvedValue(JSON.stringify({ success: true, data: [color] }));
});
afterEach(() => client.close());
const build = (active = () => true, publish = vi.fn()) =>
  commerceTools(db, env, caller, input, sessionId, active, publish);
test('validated selection and one incremental add return authoritative state and durable HTTP recovery', async () => {
  const publish = vi.fn();
  const tools = (await build(() => true, publish))!;
  expect(await tools.execute(options)).toMatchObject({
    productId: 1,
    material: 'PLA',
  });
  expect(
    await tools.execute({
      name: 'selection_set',
      arguments: { productId: 1, filamentId, quantity: 2 },
    }),
  ).toMatchObject({
    status: 'selected',
    selection: { material: 'PLA', color: '#ff0000' },
  });
  expect((await authoritativeCart(db, cartId, caller)).revision).toBe(0);
  expect(await tools.execute(add)).toMatchObject({
    status: 'applied',
    appliedRevision: 1,
    cart: { revision: 1, items: [{ quantity: 2, unitPrice: 12 }] },
  });
  await expect(tools.execute(add)).rejects.toMatchObject({ status: 409 });
  const recovery = await routes.request(
    `/cart/${cartId}/agent-actions/${sessionId}/${input.runId}`,
    {},
    env,
  );
  expect(recovery.status).toBe(200);
  expect(await recovery.json()).toMatchObject({
    status: 'applied',
    cart: { items: [{ quantity: 2 }] },
  });
  state.userId = 'other';
  expect(
    (
      await routes.request(
        `/cart/${cartId}/agent-actions/${sessionId}/${input.runId}`,
        {},
        env,
      )
    ).status,
  ).toBe(404);
});
test('direct edits supersede stale agent actions and cancelled runs cannot write', async () => {
  const tools = (await build())!;
  await tools.execute(options);
  const access = await requireCartAccess(db, cartId, caller);
  await addCartLine(db, access, selection());
  await expect(tools.execute(add)).rejects.toMatchObject({ status: 409 });
  input.cart!.revision = 1;
  let active = true;
  const next = (await build(() => active))!;
  await next.execute(options);
  active = false;
  await expect(next.execute(add)).rejects.toMatchObject({ status: 409 });
  expect((await authoritativeCart(db, cartId, caller)).items[0].quantity).toBe(
    1,
  );
});
test('receipt identity deduplicates concurrent adds, rejects changed input and survives later direct edits', async () => {
  const access = await requireCartAccess(db, cartId, caller);
  const identity = {
    id: `${cartId}:${sessionId}:${input.runId}`,
    inputHash: 'same',
    expectedRevision: 0,
  };
  await Promise.all([
    addCartLine(db, access, selection(), identity),
    addCartLine(db, access, selection(), identity),
  ]);
  const original = await authoritativeCart(db, cartId, caller);
  expect(original.items[0].quantity).toBe(1);
  expect(original.revision).toBe(1);
  await setCartLineQuantity(db, access, original.items[0].id, 4);
  await addCartLine(db, access, selection(), identity);
  expect((await authoritativeCart(db, cartId, caller)).items[0].quantity).toBe(
    4,
  );
  await expect(
    addCartLine(db, access, selection(), { ...identity, inputHash: 'changed' }),
  ).rejects.toMatchObject({ status: 409 });
});
test('hostile identity, material, price and quantity input fails schema validation; unavailable colors cannot mutate', async () => {
  const tools = (await build())!;
  await tools.execute(options);
  for (const arguments_ of [
    { ...add.arguments, userId: 'other' },
    { ...add.arguments, price: 0 },
    { ...add.arguments, filamentType: 'ABS' },
    { ...add.arguments, quantity: 70 },
    { ...add.arguments, filamentId: crypto.randomUUID() },
  ])
    await expect(
      tools.execute({ name: 'cart_add', arguments: arguments_ }),
    ).rejects.toBeTruthy();
  vi.mocked(env.COLOR_CACHE.get).mockResolvedValue(
    JSON.stringify({ success: true, data: [{ ...color, available: false }] }),
  );
  await expect(tools.execute(add)).rejects.toMatchObject({ status: 400 });
  expect((await authoritativeCart(db, cartId, caller)).items).toEqual([]);
  await expect(
    commerceTools(
      db,
      env,
      { userId: 'other' },
      input,
      sessionId,
      () => true,
      vi.fn(),
    ),
  ).rejects.toMatchObject({ status: 404 });
});
const catalog = [
  {
    id: 1,
    name: 'Bracket',
    description: 'A bracket',
    image: '',
    price: 12,
    sku: 'SKU',
    fit: null,
  },
];
const answer = {
  components: [
    { id: 'products', component: 'ProductRail', entries: ['agent-one'] },
    { id: 'agent-one', component: 'ProductEntry', productId: 1 },
    { id: 'focus', component: 'ProductFocus', productId: 1, images: [] },
  ],
  answer: 'catalog',
};
function provider(query?: object) {
  return {
    choices: [
      {
        finish_reason: query ? 'tool_calls' : 'stop',
        message: query
          ? {
              tool_calls: [
                {
                  id: crypto.randomUUID(),
                  type: 'function',
                  function: {
                    name: (query as typeof add).name,
                    arguments: JSON.stringify((query as typeof add).arguments),
                  },
                },
              ],
            }
          : { content: JSON.stringify(answer) },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}
test('the three-call tool loop charges every call and emits only confirmed cart results', async () => {
  const publish = vi.fn();
  const commerce = await build(() => true, publish);
  const accounting = {
    reserve: vi.fn(async () => ({
      status: 'reserved' as const,
      id: crypto.randomUUID(),
    })),
    settle: vi.fn(async () => 1),
  };
  const infer = vi
    .fn()
    .mockResolvedValueOnce(provider(options))
    .mockResolvedValueOnce(provider(add))
    .mockResolvedValueOnce(provider());
  await runInference(input, sessionId, {
    commerce,
    read: async () => catalog,
    infer,
    accounting,
    signal: new AbortController().signal,
    active: () => true,
    progress: vi.fn(),
  });
  expect(accounting.reserve).toHaveBeenCalledTimes(3);
  expect(accounting.settle).toHaveBeenCalledTimes(3);
  expect(publish).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'applied' }),
  );
  expect(JSON.stringify(infer.mock.calls)).not.toContain('guestToken');
});
test('budget exhaustion before the mutation turn leaves deterministic cart controls available', async () => {
  const commerce = await build();
  const accounting = {
    reserve: vi
      .fn()
      .mockResolvedValueOnce({ status: 'reserved', id: 'first' })
      .mockResolvedValue({ status: 'exhausted', id: 'second' }),
    settle: vi.fn(async () => 1),
  };
  await expect(
    runInference(input, sessionId, {
      commerce,
      read: async () => catalog,
      infer: vi.fn().mockResolvedValue(provider(options)),
      accounting,
      signal: new AbortController().signal,
      active: () => true,
      progress: vi.fn(),
    }),
  ).rejects.toMatchObject({ reason: 'budget_exhausted' });
  const access = await requireCartAccess(db, cartId, caller);
  await addCartLine(db, access, selection());
  expect((await authoritativeCart(db, cartId, caller)).items[0].quantity).toBe(
    1,
  );
});
