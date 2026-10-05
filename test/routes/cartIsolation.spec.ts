import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/app';
import * as schema from '../../src/db/schema';
import { mockBetterAuth } from '../mocks/auth';
import { mockEnv } from '../mocks/env';

const { drizzle: actualDrizzle } =
  await vi.importActual<typeof import('drizzle-orm/d1')>('drizzle-orm/d1');
const cartId = '10000000-0000-4000-8000-000000000001';
const token = '20000000-0000-4000-8000-000000000001';
const version = '30000000-0000-4000-8000-000000000001';
const raw = vi.fn();
const run = vi.fn();
const batch = vi.fn();
const statements: Array<{ query: string; params: unknown[] }> = [];
const binding = {
  /** Records Drizzle-generated statements while mocking only D1 execution. */
  prepare(query: string) {
    const statement = { query, params: [] as unknown[] };
    statements.push(statement);
    return {
      /** Retains parameter evidence without implementing an SQL evaluator. */
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
const db = actualDrizzle(binding, { schema });
const env = mockEnv();
const selection = {
  cartId,
  itemId: 1,
  quantity: 1,
  skuNumber: 'SKU-1',
  color: 'Black',
  filamentType: 'PLA',
  filamentId: token,
  userId: 'alice',
  ownerId: 'alice',
  expectedUserId: 'bob',
  successUrl: 'https://luluspeedworks.com/success',
  cancelUrl: 'https://luluspeedworks.com/cart',
};

beforeEach(() => {
  vi.mocked(drizzle).mockReturnValue(db);
  statements.length = 0;
  raw.mockReset().mockResolvedValue([]);
  run.mockReset().mockResolvedValue({ success: true });
  batch.mockReset();
  vi.mocked(fetch).mockClear();
  mockBetterAuth.getSession
    .mockReset()
    .mockImplementation(async ({ headers } = {}) => {
      const userId = headers
        ?.get('cookie')
        ?.match(/^account=(alice|bob)$/)?.[1];
      return userId
        ? {
            session: {
              id: `session-${userId}`,
              expiresAt: new Date(Date.now() + 60_000),
            },
            user: {
              id: userId,
              name: userId,
              email: `${userId}@example.com`,
              role: 'user',
            },
          }
        : null;
    });
});

/** Calls a real route with mocked identity verification and D1 transport. */
function request(
  path: string,
  method: string,
  account?: string,
  guestToken?: string,
) {
  return app.request(
    path,
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(account ? { cookie: `account=${account}` } : {}),
        ...(guestToken ? { 'X-Cart-Token': guestToken } : {}),
      },
      ...(method === 'GET'
        ? {}
        : {
            body: JSON.stringify(
              path.endsWith('/create') ? { userId: 'alice' } : selection,
            ),
          }),
    },
    env,
  );
}

const protectedRoutes = [
  { path: `/cart/${cartId}`, method: 'GET' },
  { path: '/cart/add', method: 'POST' },
  { path: '/cart/update', method: 'PUT' },
  { path: '/cart/remove', method: 'DELETE' },
  { path: `/cart/shipping?cartId=${cartId}`, method: 'GET' },
];

describe('actual cart route authorization with mocked identity and D1 transport', () => {
  test.each(
    protectedRoutes,
  )('rejects another account before reading lines or mutating: $path', async ({
    path,
    method,
  }) => {
    const response = await request(path, method, 'bob');
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(statements).toHaveLength(1);
    expect(statements[0].params).toEqual([cartId, 'bob']);
    expect(statements[0].query).toContain('"shopping_carts"."user_id" = ?');
    expect(run).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each(
    protectedRoutes,
  )('rejects anonymous callers even with forged body ownership: $path', async ({
    path,
    method,
  }) => {
    const response = await request(path, method);
    expect([401, 404]).toContain(response.status);
    expect(statements).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    'alice',
    'bob',
  ])('returns an empty cart only after authorizing the durable owner: %s', async account => {
    raw.mockResolvedValueOnce([[cartId, account, null, version]]);
    const response = await request(`/cart/${cartId}`, 'GET', account);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], total: 0 });
    expect(statements[0].params).toEqual([cartId, account]);
    expect(statements[1].params).toEqual([cartId, version]);
  });

  test('a revoked guest capability cannot read an owned cart', async () => {
    const response = await request(`/cart/${cartId}`, 'GET', undefined, token);
    expect(response.status).toBe(404);
    expect(statements).toHaveLength(1);
    expect(statements[0].query).toContain('"shopping_carts"."user_id" is null');
    expect(statements[0].params).not.toContain(token);
  });

  test('creation ignores owner claims and binds only the verified session', async () => {
    const response = await request('/cart/create', 'POST', 'bob');
    expect(response.status).toBe(201);
    expect(await response.json()).not.toHaveProperty('guestToken');
    expect(statements[0].params[1]).toBe('bob');
    expect(statements[0].params).not.toContain('alice');
  });

  test('guest creation ignores forged account ownership and returns a capability', async () => {
    const response = await request('/cart/create', 'POST');
    expect(response.status).toBe(201);
    const body = (await response.json()) as { guestToken: string };
    expect(body.guestToken).toEqual(expect.any(String));
    expect(statements[0].params[1]).toBeNull();
    expect(statements[0].params).not.toContain(body.guestToken);
  });

  test('guest claim binds the verified account despite a forged body owner', async () => {
    raw.mockResolvedValueOnce([[cartId, null, 'hash', version]]);
    batch.mockResolvedValueOnce([
      { results: [{ id: cartId }] },
      { results: [] },
    ]);
    const response = await request(
      `/cart/${cartId}/claim`,
      'POST',
      'bob',
      token,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: 'Cart claimed',
      ownerId: 'bob',
    });
    expect(
      statements.find(statement =>
        statement.query.startsWith('update "shopping_carts"'),
      )?.params[0],
    ).toBe('bob');
    expect(batch).toHaveBeenCalledOnce();
  });

  test('an account switch before claim cannot transfer the guest cart to the new account', async () => {
    const response = await request(
      `/cart/${cartId}/claim`,
      'POST',
      'alice',
      token,
    );
    expect(response.status).toBe(409);
    expect(statements).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
  });

  test.each([
    null,
    'alice',
  ])('creation rejects a stale expected identity %s before storing a cart', async expectedUserId => {
    const response = await app.request(
      '/cart/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: 'account=bob' },
        body: JSON.stringify({ expectedUserId }),
      },
      env,
    );
    expect(response.status).toBe(409);
    expect(statements).toHaveLength(0);
  });

  test('expired sessions cannot claim or prepare a cart', async () => {
    const response = await request(
      `/cart/${cartId}/claim`,
      'POST',
      'expired',
      token,
    );
    expect(response.status).toBe(401);
    expect(batch).not.toHaveBeenCalled();
    expect(statements).toHaveLength(0);
  });
});
