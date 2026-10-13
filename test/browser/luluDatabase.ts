import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { and, eq, isNull, or } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { z } from 'zod';
import * as schema from '../../src/db/schema';

const { drizzle } =
  await vi.importActual<typeof import('drizzle-orm/d1')>('drizzle-orm/d1');
type Statement = { sql: string; params: unknown[] };
type Read = { rows: unknown[][]; check?: (statement: Statement) => void };
type Plan = {
  reads: Read[];
  run?: (statement: Statement) => void;
  batch?: (statements: Statement[]) => void;
};

export const selection = {
  skuNumber: 'NATIVE-1',
  quantity: 1,
  color: 'red',
  filamentType: 'PLA',
  filamentId: '76fe1f79-3f1e-43e4-b8f4-61159de5b93c',
};

/** Scripts D1 responses per request; Drizzle still constructs every statement. */
export function luluDatabase() {
  const requests = new AsyncLocalStorage<Plan>();
  const failures: unknown[] = [];
  const writes: Statement[] = [];
  let current: typeof schema.shoppingCarts.$inferSelect | undefined;
  let quantity = 0;
  function plan() {
    const value = requests.getStore();
    if (!value) throw Error('Database work outside a planned API request');
    return value;
  }
  function verify<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      failures.push(error);
      throw error;
    }
  }
  const binding = {
    prepare(query: string) {
      const statement: Statement = { sql: query, params: [] };
      return {
        ...statement,
        bind(...params: unknown[]) {
          statement.params = params;
          return this;
        },
        get statement() {
          return statement;
        },
        async raw() {
          return verify(() => {
            const read = plan().reads.shift();
            if (!read) throw Error(`Unscripted database read: ${query}`);
            read.check?.(statement);
            return read.rows;
          });
        },
        async run() {
          return verify(() => {
            if (!plan().run) throw Error('Unscripted database write');
            plan().run?.(statement);
            writes.push(statement);
            return { success: true };
          });
        },
      };
    },
    async batch(batch: { statement: Statement }[]) {
      return verify(() => {
        if (!plan().batch) throw Error('Unscripted database batch');
        const statements = batch.map(item => item.statement);
        plan().batch?.(statements);
        writes.push(...statements);
        return [{ results: [{ id: current?.id }] }, { results: [] }];
      });
    },
  } as unknown as D1Database;
  const db = drizzle(binding, { schema });
  const row = () =>
    current
      ? [
          [
            current.id,
            current.userId,
            current.guestTokenHash,
            current.accessVersion,
            current.revision,
            current.mutationToken,
          ],
        ]
      : [];

  /** Responses are explicit fixtures, never a SQL evaluator or real database. */
  async function run(
    request: Request,
    userId: string | undefined,
    fetch: () => Response | Promise<Response>,
  ) {
    const path = new URL(request.url).pathname;
    const input = z
      .object({
        cartId: z.string().optional(),
        expectedUserId: z.string().nullable().optional(),
        quantity: z.number().optional(),
      })
      .passthrough()
      .parse(
        request.method === 'GET' || request.method === 'OPTIONS'
          ? {}
          : await request
              .clone()
              .json()
              .catch(() => ({})),
      );
    const fixture: Plan = { reads: [] };
    if (request.method !== 'OPTIONS') {
      if (path === '/categories') fixture.reads.push({ rows: [] });
      else if (path === '/products')
        fixture.reads.push({ rows: [[0]] }, { rows: [] });
      else if (path.endsWith('/sign-in/email'))
        fixture.reads.push({ rows: [] });
      else if (path === '/cart/create') {
        fixture.run = statement => {
          const [id, owner, hash, version] = statement.params;
          expect(owner).toBe(userId ?? null);
          expect(typeof id).toBe('string');
          expect(typeof version).toBe('string');
          current = {
            id: String(id),
            userId: userId ?? null,
            guestTokenHash: typeof hash === 'string' ? hash : null,
            accessVersion: String(version),
            revision: 0,
            mutationToken: null,
          };
          expect(statement).toEqual(
            db
              .insert(schema.shoppingCarts)
              .values({
                id: current.id,
                userId: current.userId,
                guestTokenHash: current.guestTokenHash,
                accessVersion: current.accessVersion,
              })
              .toSQL(),
          );
        };
      } else if (path.startsWith('/cart/')) {
        const token = request.headers.get('X-Cart-Token');
        const hash = token
          ? createHash('sha256').update(token).digest('base64')
          : undefined;
        const cartId = input.cartId ?? path.split('/')[2];
        const claim = path.endsWith('/claim');
        const identityMatches = !claim || userId === input.expectedUserId;
        const allowed =
          current?.id === cartId &&
          (current.userId === userId ||
            (current.userId === null && current.guestTokenHash === hash));
        if ((userId || token) && identityMatches)
          fixture.reads.push({
            rows: allowed ? row() : [],
            check: statement =>
              expect(statement).toEqual(
                db
                  .select()
                  .from(schema.shoppingCarts)
                  .where(
                    and(
                      eq(schema.shoppingCarts.id, cartId),
                      or(
                        userId
                          ? eq(schema.shoppingCarts.userId, userId)
                          : undefined,
                        hash
                          ? and(
                              isNull(schema.shoppingCarts.userId),
                              eq(schema.shoppingCarts.guestTokenHash, hash),
                            )
                          : undefined,
                      ),
                    ),
                  )
                  .toSQL(),
              ),
          });
        if (allowed && identityMatches && current) {
          const access = current;
          if (claim && current.userId !== userId)
            fixture.batch = statements => {
              expect(statements).toHaveLength(2);
              const version = String(statements[0].params[2]);
              expect(version).not.toBe(access.accessVersion);
              expect(statements[0]).toEqual(
                db
                  .update(schema.shoppingCarts)
                  .set({
                    userId,
                    guestTokenHash: null,
                    accessVersion: version,
                  })
                  .where(
                    and(
                      eq(schema.shoppingCarts.id, access.id),
                      eq(
                        schema.shoppingCarts.accessVersion,
                        access.accessVersion,
                      ),
                      isNull(schema.shoppingCarts.userId),
                    ),
                  )
                  .returning({ id: schema.shoppingCarts.id })
                  .toSQL(),
              );
              expect(statements[1]).toEqual(
                db
                  .update(schema.cart)
                  .set({ userId })
                  .where(
                    and(
                      eq(schema.cart.cartId, access.id),
                      eq(schema.cart.accessVersion, version),
                    ),
                  )
                  .toSQL(),
              );
              current = {
                ...access,
                userId: userId ?? null,
                guestTokenHash: null,
                accessVersion: version,
              };
            };
          else if (request.method === 'GET')
            fixture.reads.push({
              rows: quantity
                ? [
                    [
                      91,
                      access.id,
                      selection.skuNumber,
                      quantity,
                      selection.color,
                      selection.filamentType,
                      selection.filamentId,
                      'Native guest part',
                      2.29,
                    ],
                  ]
                : [],
              check: statement =>
                expect(statement.params).toEqual([
                  access.id,
                  access.accessVersion,
                ]),
            });
          else if (!claim) {
            if (path === '/cart/add') fixture.reads.push({ rows: [['PLA']] });
            fixture.reads.push(
              { rows: row() },
              {
                rows: quantity
                  ? [
                      [
                        91,
                        access.id,
                        access.accessVersion,
                        access.userId,
                        selection.skuNumber,
                        quantity,
                        selection.color,
                        selection.filamentType,
                        selection.filamentId,
                      ],
                    ]
                  : [],
              },
            );
            fixture.batch = statements => {
              expect(statements).toHaveLength(2);
              expect(statements[0].params).toEqual([
                access.revision + 1,
                expect.any(String),
                access.id,
                access.accessVersion,
                access.revision,
              ]);
              expect(statements[1].params).toEqual(
                expect.arrayContaining([access.id, access.accessVersion]),
              );
              quantity = path === '/cart/remove' ? 0 : Number(input.quantity);
              current = {
                ...access,
                revision: access.revision + 1,
                mutationToken: String(statements[0].params[1]),
              };
            };
          }
        }
      }
    }
    return requests.run(fixture, async () => {
      const response = await fetch();
      // A denied request must stop before reaching any later persistence work.
      if (response.ok) verify(() => expect(fixture.reads).toEqual([]));
      return response;
    });
  }
  return {
    db,
    binding,
    run,
    failures,
    writes,
    cart: () => current,
    quantity: () => quantity,
  };
}
