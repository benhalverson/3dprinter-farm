import { DrizzleQueryError } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/app';
import type { shoppingCarts } from '../../src/db/schema';
import { mockEnv } from '../mocks/env';

const { insert, values } = vi.hoisted(() => {
  const values =
    vi.fn<(record: typeof shoppingCarts.$inferInsert) => Promise<void>>();
  return { values, insert: vi.fn(() => ({ values })) };
});

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => ({ insert })),
}));

const errorLog = vi.fn();
const env = mockEnv();
const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

function request(authenticated = false) {
  return app.request(
    '/cart/create',
    {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:3000',
        'CF-Ray': 'cart-test-ray',
        'X-Cart-Token': 'private-guest-capability',
        ...(authenticated
          ? {
              Cookie: 'better-auth.session_token=private-session-token',
              Authorization: 'Bearer private-authorization',
            }
          : {}),
      },
    },
    env,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  values.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(errorLog);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /cart/create diagnostics', () => {
  test.each([
    false,
    true,
  ])('returns 201 without an error log (authenticated=%s)', async authenticated => {
    const response = await request(authenticated);

    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      cartId: expect.stringMatching(uuidPattern),
      message: 'Cart created successfully',
      ...(!authenticated
        ? { guestToken: expect.stringMatching(uuidPattern) }
        : {}),
    });
    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith({
      id: expect.stringMatching(uuidPattern),
      userId: authenticated ? 'user_123' : null,
      guestTokenHash: authenticated ? null : expect.any(String),
      accessVersion: expect.stringMatching(uuidPattern),
    });
    expect(errorLog).not.toHaveBeenCalled();
  });

  test.each([
    false,
    true,
  ])('logs nested failures without credentials or insert values (authenticated=%s)', async authenticated => {
    const cause = Object.assign(
      new Error('D1_ERROR: no such table: shopping_carts: SQLITE_ERROR'),
      { cause: new Error('no such table: shopping_carts') },
    );
    values.mockImplementationOnce(async record => {
      throw new DrizzleQueryError('', Object.values(record), cause);
    });

    const response = await request(authenticated);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to create cart' });
    expect(errorLog).toHaveBeenCalledOnce();
    // JSON round-trip catches nested Error objects silently becoming {}.
    const logged = JSON.stringify(errorLog.mock.calls[0][0]);
    expect(JSON.parse(logged)).toEqual({
      event: 'cart.create.failed',
      route: 'POST /cart/create',
      origin: 'http://localhost:3000',
      rayId: 'cart-test-ray',
      elapsedMs: expect.any(Number),
      authenticated,
      error: {
        name: 'Error',
        message: 'Failed database query (SQL and parameters omitted)',
        stack: expect.stringContaining('cartCreate.spec.ts'),
        cause: {
          name: 'Error',
          message: cause.message,
          stack: cause.stack,
          cause: {
            name: 'Error',
            message: cause.cause.message,
            stack: cause.cause.stack,
          },
        },
      },
    });
    expect(errorLog.mock.calls[0][0].elapsedMs).toBeGreaterThanOrEqual(0);
    const sensitiveValues = [
      'private-guest-capability',
      'private-session-token',
      'private-authorization',
      'user_123',
      'session_123',
      'test@example.com',
      env.BETTER_AUTH_SECRET,
      ...Object.values(values.mock.calls[0][0]),
    ];
    for (const value of sensitiveValues) {
      if (typeof value === 'string' && value.length > 0) {
        expect(logged).not.toContain(value);
      }
    }
  });

  test.each([
    ['unavailable', 'unavailable'],
    [null, 'Non-Error value thrown'],
    [undefined, 'Non-Error value thrown'],
    [42, 'Non-Error value thrown'],
    [{ token: 'private-thrown-object' }, 'Non-Error value thrown'],
  ])('handles a non-Error rejection: %s', async (failure, message) => {
    values.mockRejectedValueOnce(failure);

    const response = await app.request('/cart/create', { method: 'POST' }, env);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to create cart' });
    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: null,
        rayId: null,
        authenticated: false,
        error: { name: 'NonErrorThrow', message },
      }),
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      'private-thrown-object',
    );
  });

  test('bounds cyclic error causes without changing the response', async () => {
    const failure: Error & { cause?: Error } = new Error('cyclic failure');
    failure.cause = failure;
    values.mockRejectedValueOnce(failure);

    const response = await request();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to create cart' });
    expect(errorLog).toHaveBeenCalledOnce();
    const logged = JSON.stringify(errorLog.mock.calls[0][0]);
    expect(logged).toContain('Cause chain truncated');
    expect(logged.match(/"name":"Error"/g)).toHaveLength(5);
  });
});
