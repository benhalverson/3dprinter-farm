import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { cart, shoppingCarts, users } from '../../src/db/schema';
import type { WorkerEnv } from '../../src/factory';
import {
  addCartLine,
  removeCartLine,
  setCartLineQuantity,
} from '../../src/modules/cartMutations';
import {
  cartLines,
  claimCart,
  createCart,
  requireCartAccess,
} from '../../src/modules/cartOwnership';
import { createDisposableDatabase } from './disposableDatabase';

type Database = WorkerEnv['Variables']['db'];
let fixture: Awaited<ReturnType<typeof createDisposableDatabase>>;
let db: Database;

beforeAll(async () => {
  fixture = await createDisposableDatabase();
  // Production modules use the common Drizzle query/batch API. This substitutes
  // its real libsql driver for D1, without mocking queries or database results.
  db = fixture.db as unknown as Database;
  console.info(
    'Committed migration replay:',
    fixture.migrationReplay.succeeded ? 'succeeded' : 'failed',
  );
  if (!fixture.migrationReplay.succeeded)
    console.info(fixture.migrationReplay.output);
  await fixture.db.insert(users).values([
    { id: 'alice', name: 'Alice', email: 'alice@example.test' },
    { id: 'bob', name: 'Bob', email: 'bob@example.test' },
  ]);
});

afterAll(async () => {
  await fixture?.close();
});

/** Creates a guest cart and returns its real persisted authorization snapshot. */
async function guestCart() {
  const created = await createCart(db);
  const access = await requireCartAccess(db, created.cartId, {
    guestToken: created.guestToken,
  });
  return { ...created, access };
}

/** Supplies a validated configuration; catalog provider checks are covered at the route boundary. */
function selection(cartId: string, quantity = 1, skuNumber = 'SKU-1') {
  return {
    cartId,
    quantity,
    skuNumber,
    color: 'Black',
    filamentType: 'PLA',
    filamentId: '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
  };
}

/** Holds each real claim batch until both callers have completed authorization reads. */
function simultaneousClaims(database: Database): Database {
  let arrivals = 0;
  let release: () => void = () => undefined;
  const ready = new Promise<void>(resolve => {
    release = resolve;
  });
  return new Proxy(database, {
    /** Changes scheduling only; every query and batch still executes on real SQLite. */
    get(target, property, receiver) {
      if (property !== 'batch') return Reflect.get(target, property, receiver);
      return async (...args: Parameters<Database['batch']>) => {
        arrivals += 1;
        if (arrivals === 2) release();
        await ready;
        return target.batch(...args);
      };
    },
  });
}

/** Pauses one addition after its real line read to exercise a claim during an in-flight mutation. */
function pauseLineRead(database: Database) {
  let notifyRead: () => void = () => undefined;
  let resume: () => void = () => undefined;
  const readCompleted = new Promise<void>(resolve => {
    notifyRead = resolve;
  });
  const ready = new Promise<void>(resolve => {
    resume = resolve;
  });
  const paused = new Proxy(database, {
    /** Intercepts scheduling after a read; persistence and returned rows remain real. */
    get(target, property, receiver) {
      if (property !== 'query') return Reflect.get(target, property, receiver);
      return {
        ...target.query,
        cart: {
          ...target.query.cart,
          /** Returns the actual row only after the competing claim commits. */
          async findFirst(
            ...args: Parameters<Database['query']['cart']['findFirst']>
          ) {
            const row = await target.query.cart.findFirst(...args);
            notifyRead();
            await ready;
            return row;
          },
        },
      };
    },
  });
  return { database: paused, readCompleted, resume };
}

describe('real SQLite cart authorization and mutation integration', () => {
  test('persists empty ownership and rejects anonymous and different-account access', async () => {
    const owned = await createCart(db, 'alice');
    expect(owned.ownerId).toBe('alice');
    expect(owned.guestToken).toBeUndefined();
    const access = await requireCartAccess(db, owned.cartId, {
      userId: 'alice',
    });
    expect(
      await fixture.db.select().from(cart).where(cartLines(access)),
    ).toEqual([]);
    await expect(requireCartAccess(db, owned.cartId, {})).rejects.toMatchObject(
      { status: 404 },
    );
    await expect(
      requireCartAccess(db, owned.cartId, { userId: 'bob' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test('an authorized account cannot mutate another cart by guessing its line ID', async () => {
    const alice = await createCart(db, 'alice');
    const bob = await createCart(db, 'bob');
    const aliceAccess = await requireCartAccess(db, alice.cartId, {
      userId: 'alice',
    });
    const bobAccess = await requireCartAccess(db, bob.cartId, {
      userId: 'bob',
    });
    await addCartLine(db, bobAccess, selection(bob.cartId));
    const [line] = await fixture.db
      .select()
      .from(cart)
      .where(cartLines(bobAccess));
    await expect(
      setCartLineQuantity(db, aliceAccess, line.id, 4),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      removeCartLine(db, aliceAccess, line.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await fixture.db.select().from(cart).where(cartLines(bobAccess)),
    ).toEqual([line]);
  });

  test('guest capabilities cannot authorize a different guest cart', async () => {
    const first = await guestCart();
    const second = await guestCart();
    await expect(
      requireCartAccess(db, second.cartId, { guestToken: first.guestToken }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      requireCartAccess(db, first.cartId, { userId: 'alice' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test('a failed claim transaction leaves both capability and line ownership intact', async () => {
    const guest = await guestCart();
    await addCartLine(db, guest.access, selection(guest.cartId));
    await expect(
      claimCart(db, guest.cartId, {
        userId: 'deleted-account',
        guestToken: guest.guestToken,
      }),
    ).rejects.toThrow();
    expect(
      await requireCartAccess(db, guest.cartId, {
        guestToken: guest.guestToken,
      }),
    ).toEqual(guest.access);
    const [line] = await fixture.db
      .select()
      .from(cart)
      .where(cartLines(guest.access));
    expect(line).toMatchObject({
      userId: null,
      quantity: 1,
      accessVersion: guest.access.accessVersion,
    });
  });

  test('claims an empty guest cart exactly once and revokes its capability', async () => {
    const guest = await guestCart();
    expect(guest.access.guestTokenHash).not.toBe(guest.guestToken);
    await expect(
      claimCart(db, guest.cartId, { guestToken: guest.guestToken }),
    ).rejects.toMatchObject({ status: 401 });
    await claimCart(db, guest.cartId, {
      userId: 'alice',
      guestToken: guest.guestToken,
    });
    await claimCart(db, guest.cartId, { userId: 'alice' });
    const owned = await requireCartAccess(db, guest.cartId, {
      userId: 'alice',
    });
    expect(owned.guestTokenHash).toBeNull();
    expect(owned.accessVersion).not.toBe(guest.access.accessVersion);
    await expect(
      requireCartAccess(db, guest.cartId, { guestToken: guest.guestToken }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      claimCart(db, guest.cartId, {
        userId: 'bob',
        guestToken: guest.guestToken,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test('cascades the authorization version and blocks stale guest reads and every mutation', async () => {
    const guest = await guestCart();
    await addCartLine(db, guest.access, selection(guest.cartId));
    const [line] = await fixture.db
      .select()
      .from(cart)
      .where(cartLines(guest.access));
    await claimCart(db, guest.cartId, {
      userId: 'alice',
      guestToken: guest.guestToken,
    });
    const owned = await requireCartAccess(db, guest.cartId, {
      userId: 'alice',
    });
    expect(
      await fixture.db.select().from(cart).where(cartLines(guest.access)),
    ).toEqual([]);
    await expect(
      addCartLine(db, guest.access, selection(guest.cartId, 1, 'SKU-2')),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      setCartLineQuantity(db, guest.access, line.id, 4),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      removeCartLine(db, guest.access, line.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await fixture.db.select().from(cart).where(cartLines(owned)),
    ).toEqual([
      expect.objectContaining({
        id: line.id,
        userId: 'alice',
        quantity: 1,
        accessVersion: owned.accessVersion,
      }),
    ]);
  });

  test('two claims authorized before either write produce exactly one owner and no mixed lines', async () => {
    const guest = await guestCart();
    await addCartLine(db, guest.access, selection(guest.cartId));
    const racingDb = simultaneousClaims(db);
    const claims = await Promise.allSettled([
      claimCart(racingDb, guest.cartId, {
        userId: 'alice',
        guestToken: guest.guestToken,
      }),
      claimCart(racingDb, guest.cartId, {
        userId: 'bob',
        guestToken: guest.guestToken,
      }),
    ]);
    expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(claims.find(result => result.status === 'rejected')).toMatchObject({
      reason: { status: 409 },
    });
    const [owner] = await fixture.db
      .select()
      .from(shoppingCarts)
      .where(eq(shoppingCarts.id, guest.cartId));
    const lines = await fixture.db
      .select()
      .from(cart)
      .where(eq(cart.cartId, guest.cartId));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      userId: owner.userId,
      accessVersion: owner.accessVersion,
    });
    const loser = owner.userId === 'alice' ? 'bob' : 'alice';
    await expect(
      requireCartAccess(db, guest.cartId, {
        userId: loser,
        guestToken: guest.guestToken,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test.each([
    false,
    true,
  ])('a claim revokes an in-flight guest addition (existing line: %s)', async existingLine => {
    const guest = await guestCart();
    if (existingLine)
      await addCartLine(db, guest.access, selection(guest.cartId));
    const paused = pauseLineRead(db);
    const addition = addCartLine(
      paused.database,
      guest.access,
      selection(guest.cartId),
    );
    await paused.readCompleted;
    try {
      await claimCart(db, guest.cartId, {
        userId: 'alice',
        guestToken: guest.guestToken,
      });
    } finally {
      paused.resume();
    }
    await expect(addition).rejects.toMatchObject({ status: 409 });
    const owned = await requireCartAccess(db, guest.cartId, {
      userId: 'alice',
    });
    const lines = await fixture.db.select().from(cart).where(cartLines(owned));
    expect(lines).toHaveLength(existingLine ? 1 : 0);
    if (existingLine)
      expect(lines[0]).toMatchObject({ quantity: 1, userId: 'alice' });
  });

  test('concurrent additions preserve successful quantities and never duplicate a configuration', async () => {
    const guest = await guestCart();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        addCartLine(db, guest.access, selection(guest.cartId)),
      ),
    );
    const successes = results.filter(
      result => result.status === 'fulfilled',
    ).length;
    const failures = results.filter(result => result.status === 'rejected');
    expect(successes).toBeGreaterThan(0);
    for (const failure of failures)
      expect(failure).toMatchObject({ reason: { status: 409 } });
    const lines = await fixture.db
      .select()
      .from(cart)
      .where(cartLines(guest.access));
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(successes);
    expect(Number.isInteger(lines[0].quantity)).toBe(true);
  });

  test('racing additions cannot exceed the validated integer quantity limit', async () => {
    const guest = await guestCart();
    await addCartLine(db, guest.access, selection(guest.cartId, 68));
    const results = await Promise.allSettled([
      addCartLine(db, guest.access, selection(guest.cartId)),
      addCartLine(db, guest.access, selection(guest.cartId)),
    ]);
    expect(
      results.filter(result => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const [line] = await fixture.db
      .select()
      .from(cart)
      .where(cartLines(guest.access));
    expect(line.quantity).toBe(69);
    await expect(
      addCartLine(db, guest.access, selection(guest.cartId)),
    ).rejects.toMatchObject({ status: 400 });
    await setCartLineQuantity(db, guest.access, line.id, 0);
    expect(
      await fixture.db.select().from(cart).where(cartLines(guest.access)),
    ).toEqual([]);
    expect(
      await requireCartAccess(db, guest.cartId, {
        guestToken: guest.guestToken,
      }),
    ).toEqual(guest.access);
  });
});
