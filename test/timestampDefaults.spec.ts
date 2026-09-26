import { getTableColumns } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../src/db/schema';

const { drizzle } =
  await vi.importActual<typeof import('drizzle-orm/d1')>('drizzle-orm/d1');
const db = drizzle({} as D1Database);
const now = new Date('2026-09-26T07:08:09.987Z');

describe('application timestamp defaults', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it('keeps UTC text at second precision and leaves all defaults insert-only', () => {
    for (const table of [
      schema.productsToCategories,
      schema.ordersTable,
      schema.orderEventsTable,
      schema.orderCancellationAttemptsTable,
      schema.orderNotificationAttemptsTable,
      schema.orderReconciliationAttemptsTable,
    ]) {
      const columns = getTableColumns(table);
      for (const column of Object.values(columns)) {
        if (!column.defaultFn) continue;
        expect(column.defaultFn()).toBe('2026-09-26 07:08:09');
        expect(column.default).toBeUndefined();
        expect(column.onUpdateFn).toBeUndefined();
      }
    }
    const params = db
      .insert(schema.productsToCategories)
      .values({ productId: 1, categoryId: 2 })
      .toSQL().params;
    expect(params).toEqual([1, 2, '2026-09-26 07:08:09']);
  });

  it('retains Date mappings and millisecond precision', () => {
    for (const table of [
      schema.users,
      schema.session,
      schema.account,
      schema.verification,
    ]) {
      for (const column of [table.createdAt, table.updatedAt]) {
        expect(column.defaultFn?.()).toEqual(now);
        expect(column.mapToDriverValue(now)).toBe(now.getTime());
        expect(column.mapFromDriverValue(now.getTime())).toEqual(now);
        expect(column.default).toBeUndefined();
        expect(column.onUpdateFn).toBeUndefined();
      }
    }
    const params = db
      .insert(schema.verification)
      .values({
        id: 'id',
        identifier: 'identifier',
        value: 'value',
        expiresAt: now,
      })
      .toSQL().params;
    expect(params.slice(-2)).toEqual([now.getTime(), now.getTime()]);
  });

  it('retains seconds precision for timestamp mode', () => {
    for (const table of [
      schema.stripeFulfillmentTable,
      schema.uploadedFilesTable,
    ]) {
      for (const column of [table.createdAt, table.updatedAt]) {
        expect(column.defaultFn?.()).toEqual(now);
        expect(column.mapToDriverValue(now)).toBe(
          Math.floor(now.getTime() / 1000),
        );
        expect(
          column.mapFromDriverValue(Math.floor(now.getTime() / 1000)),
        ).toEqual(new Date('2026-09-26T07:08:09Z'));
        expect(column.onUpdateFn).toBeUndefined();
      }
    }
    expect(
      db
        .insert(schema.stripeFulfillmentTable)
        .values({
          idempotencyKey: 'id',
          stripeEventId: 'event',
          stripeObjectId: 'object',
          cartId: 'cart',
        })
        .toSQL()
        .params.slice(-2),
    ).toEqual([1790406489, 1790406489]);
  });

  it('preserves explicit dates, text, null values, and nullable constraints', () => {
    const explicit = new Date('2020-01-02T03:04:05.678Z');
    expect(
      db
        .insert(schema.verification)
        .values({
          id: 'id',
          identifier: 'identifier',
          value: 'value',
          expiresAt: now,
          createdAt: explicit,
          updatedAt: null,
        })
        .toSQL()
        .params.slice(-2),
    ).toEqual([explicit.getTime(), null]);
    expect(
      db
        .insert(schema.productsToCategories)
        .values({
          productId: 1,
          categoryId: 2,
          createdAt: '2020-01-02 03:04:05',
        })
        .toSQL()
        .params.at(-1),
    ).toBe('2020-01-02 03:04:05');
    expect(schema.verification.createdAt.notNull).toBe(false);
    expect(schema.verification.updatedAt.notNull).toBe(false);
    expect(schema.ordersTable.createdAt.notNull).toBe(false);
    expect(schema.ordersTable.updatedAt.notNull).toBe(false);
    expect(schema.productsToCategories.createdAt.notNull).toBe(true);
    const update = db
      .update(schema.verification)
      .set({ value: 'changed' })
      .toSQL();
    expect(update.params).toEqual(['changed']);
  });
});
