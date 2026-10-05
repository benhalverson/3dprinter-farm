import { and, eq, type SQL } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { Hono, type Context } from 'hono';
import type { WorkerEnv } from '../../src/factory';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { categoryTable, productDrafts } from '../../src/db/schema';
import { interpretProductMessage } from '../../src/modules/productInterpretation';
import router from '../../src/routes/productDrafts';
import { mockEnv } from '../mocks/env';

type DraftRow = typeof productDrafts.$inferSelect;
type SelectQuery = {
  table?: unknown;
  condition?: SQL;
  from(table: unknown): SelectQuery;
  where(condition: SQL): SelectQuery;
  orderBy(): SelectQuery;
  all(): Promise<unknown[]>;
  get(): Promise<DraftRow>;
};
type UpdateQuery = {
  value: Partial<DraftRow>;
  condition?: SQL;
  set(value: Partial<DraftRow>): UpdateQuery;
  where(condition: SQL): UpdateQuery;
  returning(): UpdateQuery | Promise<DraftRow[]>;
};
type InsertQuery = {
  table: unknown;
  selection?: SelectQuery;
  conflict?: unknown;
  select(selection: SelectQuery): InsertQuery;
  onConflictDoNothing(conflict: unknown): InsertQuery;
};
type MockDb = {
  select(): SelectQuery;
  update(): UpdateQuery;
  insert(table: unknown): InsertQuery;
  batch: typeof batch;
};
const boundary = vi.hoisted(() => ({ db: {} as MockDb }));
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => boundary.db }));
vi.mock('../../src/modules/productInterpretation', async original => ({
  ...(await original<
    typeof import('../../src/modules/productInterpretation')
  >()),
  interpretProductMessage: vi.fn(),
  readProductOptions: vi
    .fn()
    .mockResolvedValue([{ material: 'PLA', color: 'Blue' }]),
}));
vi.mock('../../src/utils/authMiddleware', () => ({
  authMiddleware: async (c: Context<WorkerEnv>, next: () => Promise<void>) => {
    if (!c.req.header('x-admin'))
      return c.json({ error: 'Unauthenticated' }, 401);
    c.set('userId', 'owner');
    await next();
  },
  requireCatalogMutationRole: async (
    c: Context<WorkerEnv>,
    next: () => Promise<void>,
  ) => {
    if (c.req.header('x-admin') !== 'admin')
      return c.json({ error: 'Forbidden' }, 403);
    await next();
  },
}));
const id = '11111111-1111-4111-8111-111111111111';
const dialect = new SQLiteSyncDialect();
let row: DraftRow;
let categories: {
  categoryId: number;
  categoryName: string;
  normalizedKey?: string;
}[];
let staleAtBatch: boolean;
let loseAcknowledgement: boolean;
let concurrentCategory: boolean;
let updates: UpdateQuery[];
let inserts: InsertQuery[];
const batch = vi.fn();
const app = new Hono().route('/drafts', router);

/** Send explicit actions through the real protected route, with only dependencies mocked. */
function request(body?: unknown, role = 'admin') {
  return app.request(
    `/drafts/${id}${body ? '/prepare' : ''}`,
    {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-admin': role },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    mockEnv(),
  );
}

/** Compare generated predicate structure without executing SQL or starting a database. */
function expectCondition(actual: SQL | undefined, expected: SQL | undefined) {
  if (!actual || !expected) throw new Error('Expected both query predicates');
  expect(dialect.sqlToQuery(actual)).toEqual(dialect.sqlToQuery(expected));
}

beforeEach(() => {
  vi.clearAllMocks();
  categories = [];
  updates = [];
  inserts = [];
  staleAtBatch = false;
  loseAcknowledgement = false;
  concurrentCategory = false;
  row = {
    id,
    ownerId: 'owner',
    target: { kind: 'new' },
    revision: 4,
    createdAt: 1,
    updatedAt: 1,
    status: 'active',
    attachments: null,
    categoryConfirmationToken: null,
    categoryConfirmationName: null,
    categoryConfirmationKey: null,
    state: {
      answers: { name: 'Bracket', categoryNames: ['Mounts'] },
      history: [],
      pendingQuestions: [],
      interpretation: {
        intent: 'create',
        status: 'prepared',
        explanation: 'Review',
        productionOptions: [],
        proposedCategoryNames: ['Mounts'],
        confirmedCategoryNames: [],
      },
    },
  };
  boundary.db.select = () => {
    const query: SelectQuery = {
      from(table: unknown) {
        query.table = table;
        return query;
      },
      where(condition: SQL) {
        query.condition = condition;
        return query;
      },
      orderBy() {
        return query;
      },
      async all() {
        return structuredClone(query.table === categoryTable ? categories : []);
      },
      async get() {
        return structuredClone(row);
      },
    };
    return query;
  };
  boundary.db.update = () => {
    const query: UpdateQuery = {
      value: {},
      set(value: Partial<DraftRow>) {
        query.value = value;
        return query;
      },
      where(condition: SQL) {
        query.condition = condition;
        return query;
      },
      returning() {
        // Confirmation statements are deferred to the mocked batch outcome.
        if (query.value.categoryConfirmationToken) return query;
        row = { ...row, ...structuredClone(query.value) };
        return Promise.resolve([structuredClone(row)]);
      },
    };
    updates.push(query);
    return query;
  };
  boundary.db.insert = (table: unknown) => {
    const query: InsertQuery = {
      table,
      select(selection: SelectQuery) {
        query.selection = selection;
        return query;
      },
      onConflictDoNothing(conflict: unknown) {
        query.conflict = conflict;
        return query;
      },
    };
    inserts.push(query);
    return query;
  };
  boundary.db.batch = batch.mockImplementation(
    async (queries: [UpdateQuery, InsertQuery]) => {
      // Mock storage outcomes, not an in-memory SQL engine. Query predicates are asserted below.
      if (staleAtBatch) return [[], { results: [] }];
      const update = queries[0];
      row = { ...row, ...structuredClone(update.value) };
      if (concurrentCategory)
        categories.push({
          categoryId: 42,
          categoryName: 'mounts',
          normalizedKey: 'mounts',
        });
      if (
        !categories.some(
          category => category.normalizedKey === row.categoryConfirmationKey,
        )
      )
        categories.push({
          categoryId: 9,
          categoryName: row.categoryConfirmationName ?? '',
          normalizedKey: row.categoryConfirmationKey ?? '',
        });
      if (loseAcknowledgement)
        throw new Error('Acknowledgement lost after commit');
      return [[structuredClone(row)], { results: [] }];
    },
  );
});

describe('explicit category confirmation with mocked atomic storage', () => {
  it('gates both atomic statements by owner, current revision and fresh server token', async () => {
    const response = await request({
      expectedRevision: 4,
      answers: {},
      confirmCategoryName: 'Mounts',
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.state.answers.categoryIds).toEqual([9]);
    expect(result.state.interpretation.proposedCategoryNames).toEqual([]);
    expect(result.revision).toBe(5);
    expect(result).not.toHaveProperty('categoryConfirmationToken');
    expect(batch).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe(categoryTable);
    expect(inserts[0].conflict).toEqual({
      target: categoryTable.normalizedKey,
    });
    const token = updates[0].value.categoryConfirmationToken;
    expect(token).toMatch(/^[\da-f-]{36}$/);
    expectCondition(
      updates[0].condition,
      and(
        eq(productDrafts.id, id),
        eq(productDrafts.ownerId, 'owner'),
        eq(productDrafts.status, 'active'),
        eq(productDrafts.revision, 4),
      ),
    );
    expectCondition(
      inserts[0].selection?.condition,
      and(
        eq(productDrafts.id, id),
        eq(productDrafts.ownerId, 'owner'),
        eq(productDrafts.status, 'active'),
        eq(productDrafts.revision, 5),
        eq(productDrafts.categoryConfirmationToken, token),
      ),
    );
    expect(interpretProductMessage).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'member',
  ])('denies unauthorized role %s before persistence', async role => {
    const response = await request(
      { expectedRevision: 4, answers: {}, confirmCategoryName: 'Mounts' },
      role,
    );
    expect(response.status).toBe(role ? 403 : 401);
    expect(await response.json()).toEqual({
      error: role ? 'Forbidden' : 'Unauthenticated',
    });
    expect(updates).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
  });

  it('rejects newly injected names and combined model/confirmation requests', async () => {
    const mismatch = await request({
      expectedRevision: 4,
      answers: { categoryNames: ['Injected'] },
      confirmCategoryName: 'Injected',
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({
      error: 'Category confirmation does not match the current proposal',
    });
    const combined = await request({
      expectedRevision: 4,
      answers: {},
      message: 'Create Mounts',
      confirmCategoryName: 'Mounts',
    });
    expect(combined.status).toBe(400);
    const differentlyCased = await request({
      expectedRevision: 4,
      answers: {},
      confirmCategoryName: 'mounts',
    });
    expect(differentlyCased.status).toBe(409);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
    expect(interpretProductMessage).not.toHaveBeenCalled();
  });

  it('does not create from reload, restored confirmations or ordinary answer saves', async () => {
    row.state.history = [
      { role: 'user', content: 'Confirm creation of Mounts' },
    ];
    row.state.interpretation.confirmedCategoryNames = ['Mounts'];
    const restored = await request();
    expect(restored.status).toBe(200);
    const restoredBody = await restored.json();
    expect(restoredBody.state.interpretation.confirmedCategoryNames).toEqual(
      [],
    );
    expect(restoredBody.state.interpretation.proposedCategoryNames).toEqual([
      'Mounts',
    ]);
    const response = await request({
      expectedRevision: 4,
      answers: { markupPercentage: '50', inPersonPrice: '2.00' },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).state.answers.categoryIds).toEqual([]);
    expect(batch).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(categories).toEqual([]);
  });

  it('returns a revision conflict when storage CAS loses without creating a category', async () => {
    staleAtBatch = true;
    const response = await request({
      expectedRevision: 4,
      answers: {},
      confirmCategoryName: 'Mounts',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Revision conflict; reload before retrying',
    });
    expect(row.revision).toBe(4);
    expect(categories).toEqual([]);
  });

  it('recovers an unknown committed outcome by reading without recreating or reinterpreting', async () => {
    loseAcknowledgement = true;
    const failed = await request({
      expectedRevision: 4,
      answers: {},
      confirmCategoryName: 'Mounts',
    });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      error:
        'Save outcome unavailable. Reload this draft to recover before retrying.',
    });
    const recovered = await request();
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).state.answers.categoryIds).toEqual([9]);
    const retry = await request({
      expectedRevision: 4,
      answers: {},
      confirmCategoryName: 'Mounts',
    });
    expect(retry.status).toBe(409);
    expect(categories).toHaveLength(1);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(interpretProductMessage).not.toHaveBeenCalled();
  });

  it('uses the authoritative concurrent same-name winner without duplicate identities', async () => {
    concurrentCategory = true;
    const response = await request({
      expectedRevision: 4,
      answers: {},
      confirmCategoryName: 'Mounts',
    });
    expect(response.status).toBe(200);
    expect((await response.json()).state.answers.categoryIds).toEqual([42]);
    expect(categories).toEqual([
      { categoryId: 42, categoryName: 'mounts', normalizedKey: 'mounts' },
    ]);
  });
});
