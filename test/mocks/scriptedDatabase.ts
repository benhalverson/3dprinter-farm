import { vi } from 'vitest';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type * as schema from '../../src/db/schema';

/** Explicit query responses, not a database or SQL interpreter. Unscripted reads fail. */
export function scriptedDatabase(...responses: unknown[]) {
  const replies = [...responses];
  const calls: { method: string; args: unknown[] }[] = [];
  const take = () => {
    if (!replies.length) throw new Error('Unscripted database response');
    const value = replies.shift();
    return value instanceof Error
      ? Promise.reject(value)
      : Promise.resolve(value);
  };
  const chain = () => {
    const query: Record<string, unknown> = {};
    for (const method of [
      'from',
      'where',
      'limit',
      'orderBy',
      'values',
      'set',
      'onConflictDoNothing',
      'onConflictDoUpdate',
      'innerJoin',
      'leftJoin',
    ]) {
      query[method] = vi.fn((...args: unknown[]) => {
        calls.push({ method, args });
        return query;
      });
    }
    for (const method of ['get', 'all', 'returning', 'run'])
      query[method] = vi.fn(take);
    // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are awaitable; this scripts their boundary.
    query.then = (
      resolve: (value: unknown) => unknown,
      reject: (reason: unknown) => unknown,
    ) => take().then(resolve, reject);
    return query;
  };
  const db = Object.fromEntries(
    ['select', 'insert', 'update', 'delete'].map(method => [
      method,
      vi.fn((...args: unknown[]) => {
        calls.push({ method, args });
        return chain();
      }),
    ]),
  );
  db.batch = vi.fn(take);
  return {
    db: db as unknown as DrizzleD1Database<typeof schema>,
    calls,
    replies,
  };
}
