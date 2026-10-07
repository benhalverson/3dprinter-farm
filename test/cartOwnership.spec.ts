import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as schema from '../src/db/schema';
import type { WorkerEnv } from '../src/factory';
import {
  cartLines,
  claimCart,
  createCart,
  requireCartAccess,
} from '../src/modules/cartOwnership';
import {
  addCartLine,
  removeCartLine,
  setCartLineQuantity,
} from '../src/modules/cartMutations';
import { cartAccessMiddleware } from '../src/utils/cartAccessMiddleware';

const { drizzle } =
  await vi.importActual<typeof import('drizzle-orm/d1')>('drizzle-orm/d1');
const cartId = '10000000-0000-4000-8000-000000000001';
const guestToken = '20000000-0000-4000-8000-000000000001';
const version = '30000000-0000-4000-8000-000000000001';
const raw = vi.fn();
const run = vi.fn();
const batch = vi.fn();
const statements: Array<{ query: string; params: unknown[] }> = [];
const binding = {
  prepare(query: string) {
    const statement = { query, params: [] as unknown[] };
    statements.push(statement);
    return {
      bind(...params: unknown[]) {
        statement.params = params;
        return this;
      },
      raw,
      run,
    };
  },
  batch,
} as unknown as D1Database;
const db = drizzle(binding, { schema });

beforeEach(() => {
  statements.length = 0;
  raw.mockReset().mockResolvedValue([]);
  run.mockReset().mockResolvedValue({ success: true });
  batch.mockReset();
});

describe('cart ownership through Drizzle with mocked D1 responses', () => {
  test('persists an empty guest cart and stores only a hash of its capability', async () => {
    const created = await createCart(db);
    expect(created.guestToken).toBeTruthy();
    expect(statements[0].params[0]).toBe(created.cartId);
    expect(statements[0].params[1]).toBeNull();
    expect(statements[0].params[2]).toEqual(expect.any(String));
    expect(statements[0].params).not.toContain(created.guestToken);
    expect(run).toHaveBeenCalledOnce();
  });

  test('owned carts have no guest capability', async () => {
    const created = await createCart(db, 'alice');
    expect(created.guestToken).toBeUndefined();
    expect(statements[0].params.slice(1, 3)).toEqual(['alice', null]);
  });

  test('anonymous callers without a capability cannot query even an empty cart', async () => {
    await expect(requireCartAccess(db, cartId, {})).rejects.toMatchObject({
      status: 404,
    });
    expect(statements).toHaveLength(0);
  });

  test('a guest capability only matches an unowned cart', async () => {
    raw.mockResolvedValueOnce([[cartId, null, 'hash', version, 0, null]]);
    const access = await requireCartAccess(db, cartId, { guestToken });
    expect(access.accessVersion).toBe(version);
    expect(statements[0].query).toContain('"shopping_carts"."user_id" is null');
    expect(statements[0].query).toContain(
      '"shopping_carts"."guest_token_hash" = ?',
    );
    expect(statements[0].params).not.toContain(guestToken);
  });

  test.each([
    'alice',
    'bob',
  ])('restricts a session to its own cart: %s', async userId => {
    await expect(
      requireCartAccess(db, cartId, { userId }),
    ).rejects.toMatchObject({ status: 404 });
    expect(statements[0].params).toEqual([cartId, userId]);
    expect(statements[0].query).toContain('"shopping_carts"."user_id" = ?');
    expect(statements[0].query).not.toContain(' or ');
  });

  test('claim requires an authenticated session', async () => {
    await expect(claimCart(db, cartId, { guestToken })).rejects.toMatchObject({
      status: 401,
    });
    expect(batch).not.toHaveBeenCalled();
  });

  test('claim atomically rotates the authorization version and updates line owners', async () => {
    raw.mockResolvedValueOnce([[cartId, null, 'hash', version, 0, null]]);
    batch.mockResolvedValueOnce([
      { results: [{ id: cartId }] },
      { results: [] },
    ]);
    await claimCart(db, cartId, { userId: 'alice', guestToken });
    expect(batch).toHaveBeenCalledOnce();
    const update = statements.find(item =>
      item.query.startsWith('update "shopping_carts"'),
    );
    expect(update?.params).toEqual([
      'alice',
      null,
      expect.any(String),
      cartId,
      version,
    ]);
    expect(update?.query).toContain('"shopping_carts"."user_id" is null');
    const lineUpdate = statements.find(item =>
      item.query.startsWith('update "cart"'),
    );
    expect(lineUpdate?.params).toEqual(['alice', cartId, update?.params[2]]);
    expect(update?.params[2]).not.toBe(version);
  });

  test('a lost claim race is reported rather than silently succeeding', async () => {
    raw.mockResolvedValueOnce([[cartId, null, 'hash', version, 0, null]]);
    batch.mockResolvedValueOnce([{ results: [] }, { results: [] }]);
    await expect(
      claimCart(db, cartId, { userId: 'bob', guestToken }),
    ).rejects.toMatchObject({ status: 409 });
  });

  test('the owning account can retry a completed claim without changing ownership', async () => {
    raw.mockResolvedValueOnce([[cartId, 'alice', null, version, 0, null]]);
    await claimCart(db, cartId, { userId: 'alice' });
    expect(batch).not.toHaveBeenCalled();
  });

  test('line queries bind both cart and authorization version', () => {
    const query = db
      .select()
      .from(schema.cart)
      .where(
        cartLines({
          id: cartId,
          userId: 'alice',
          guestTokenHash: null,
          accessVersion: version,
    revision:0,mutationToken:null,
        }),
      )
      .toSQL();
    expect(query.params).toEqual([cartId, version]);
    expect(query.sql).toContain('"cart"."access_version" = ?');
  });
});

describe('cart access middleware', () => {
  const app = new Hono<WorkerEnv>()
    .use('*', async (c, next) => {
      c.set('db', db);
      c.set('userId', c.req.header('Test-User'));
      await next();
    })
    .get('/cart/:cartId', cartAccessMiddleware, c =>
      c.json({ id: c.var.cartAccess.id }),
    )
    .post('/cart/:cartId/checkout', cartAccessMiddleware, c =>
      c.json({ prepared: true }),
    )
    .put('/cart/update', cartAccessMiddleware, c => c.json({ updated: true }));

  test('missing capability blocks the handler and prevents caching', async () => {
    const response = await app.request(`/cart/${cartId}`);
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  test('an authenticated guest must claim before preparing a payment', async () => {
    raw.mockResolvedValueOnce([[cartId, null, 'hash', version, 0, null]]);
    const response = await app.request(`/cart/${cartId}/checkout`, {
      method: 'POST',
      headers: { 'Test-User': 'alice', 'X-Cart-Token': guestToken },
    });
    expect(response.status).toBe(401);
  });

  test('owned cart can prepare a payment', async () => {
    raw.mockResolvedValueOnce([[cartId, 'alice', null, version, 0, null]]);
    const response = await app.request(`/cart/${cartId}/checkout`, {
      method: 'POST',
      headers: { 'Test-User': 'alice' },
    });
    expect(response.status).toBe(200);
  });

  test('malformed mutation bodies are rejected before accessing storage', async () => {
    const response = await app.request('/cart/update', {
      method: 'PUT',
      body: 'invalid json',
    });
    expect(response.status).toBe(400);
    expect(statements).toHaveLength(0);
  });
});

describe('cart mutations preserve authorization versions and atomic results', () => {
  const access = {
    id: cartId,
    userId: null,
    guestTokenHash: 'hash',
    accessVersion: version,
    revision:0,mutationToken:null,
  };
  const selection = {
    cartId,
    skuNumber: 'SKU-1',
    quantity: 1,
    color: 'Black',
    filamentType: 'PLA',
    filamentId: guestToken,
  };

  test('an update invalidated by a claim cannot report success', async () => {
    await expect(setCartLineQuantity(db, access, 1, 2)).rejects.toMatchObject({
      status: 404,
    });
    expect(statements[0].params).toEqual([cartId, version]);
    expect(batch).not.toHaveBeenCalled();
  });

  test.each([
    true,
    false,
  ])('a stale deletion or zero-quantity update cannot report success: %s', async remove => {
    await expect(
      remove
        ? removeCartLine(db, access, 1)
        : setCartLineQuantity(db, access, 1, 0),
    ).rejects.toMatchObject({ status: 404 });
    expect(statements[0].params).toEqual([cartId, version]);
    expect(batch).not.toHaveBeenCalled();
  });

  test.each([1, 0])('confirms changed rows for quantity %s', async quantity => {
    raw.mockResolvedValueOnce([[cartId,null,'hash',version,0,null]]).mockResolvedValueOnce([[1,cartId,version,null,'SKU-1',2,'Black','PLA',guestToken]]);
    batch.mockResolvedValueOnce([{results:[{id:cartId}]},{results:[]}]);
    await expect(
      setCartLineQuantity(db, access, 1, quantity),
    ).resolves.toBeUndefined();
  });

  test.each(['FOREIGN KEY constraint failed','UNIQUE constraint failed'])('atomic constraint failure is a retry conflict: %s',async message=>{
    raw.mockResolvedValueOnce([[cartId,null,'hash',version,0,null]]).mockResolvedValueOnce([]);
    batch.mockRejectedValueOnce(new Error('Failed query',{cause:new Error(message)}));
    await expect(addCartLine(db,access,selection)).rejects.toMatchObject({status:409});
    expect(batch).toHaveBeenCalledOnce();
  });
  test('unrelated storage failures are not mislabeled as user conflicts',async()=>{
    const failure=new Error('Storage unavailable');
    raw.mockResolvedValueOnce([[cartId,null,'hash',version,0,null]]).mockRejectedValueOnce(failure);
    await expect(addCartLine(db,access,selection)).rejects.toMatchObject({cause:failure});
  });
  test('the revision and authorization version guard the entire mutation batch',async()=>{
    raw.mockResolvedValueOnce([[cartId,null,'hash',version,3,null]]).mockResolvedValueOnce([[1,cartId,version,null,'SKU-1',2,'Black','PLA',guestToken]]);
    batch.mockResolvedValueOnce([{results:[]},{results:[]}]);
    await expect(addCartLine(db,access,selection)).rejects.toMatchObject({status:409});
    const gate=statements.find(statement=>statement.query.startsWith('update "shopping_carts"'))!;
    expect(gate.params).toContain(version);expect(gate.query).toContain('"shopping_carts"."revision" = ?');
    const effect=statements.find(statement=>statement.query.startsWith('update "cart"'))!;
    expect(effect.params).toContain(version);expect(effect.query).toContain('"shopping_carts"."mutation_token" = ?');
  });
});
