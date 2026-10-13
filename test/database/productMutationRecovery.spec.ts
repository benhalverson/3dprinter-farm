import { drizzle } from 'drizzle-orm/d1';
import { expect, test, vi } from 'vitest';
import { reconcileProductMutation } from '../../src/modules/productMutations';
import { scriptedDatabase } from '../mocks/scriptedDatabase';
import { mockEnv } from '../mocks/env';

const boundary = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => boundary.db }));
const operation = {
  id: 'operation',
  ownerId: 'owner',
  draftId: 'draft',
  state: 'prepared',
  action: 'update',
  preparation: { snapshot: null },
};
function fixture(...responses: unknown[]) {
  const mock = scriptedDatabase(...responses);
  boundary.db = mock.db;
  return { ...mock, db: drizzle({} as D1Database) };
}
test('missing saved operation fails before provider dispatch', async () => {
  const mock = fixture(undefined);
  await expect(
    reconcileProductMutation(mock.db, mockEnv(), 'owner', 'draft', 'operation'),
  ).rejects.toThrow('operation_not_found');
  expect(fetch).not.toHaveBeenCalled();
});
test('an interrupted inert operation is retired and requires fresh preparation', async () => {
  const retired = {
    ...operation,
    state: 'failed',
    error: 'inert_operation_retired_reprepare',
  };
  const mock = fixture(operation, [retired]);
  expect(
    await reconcileProductMutation(
      mock.db,
      mockEnv(),
      'owner',
      'draft',
      'operation',
    ),
  ).toEqual(retired);
  expect(mock.calls.find(call => call.method === 'set')?.args[0]).toMatchObject(
    { state: 'failed', error: 'inert_operation_retired_reprepare' },
  );
  expect(fetch).not.toHaveBeenCalled();
});
test('a lost mocked retirement race reads the saved winner', async () => {
  const winner = { ...operation, state: 'failed' };
  const mock = fixture(operation, [], winner);
  expect(
    await reconcileProductMutation(
      mock.db,
      mockEnv(),
      'owner',
      'draft',
      'operation',
    ),
  ).toEqual(winner);
  expect(fetch).not.toHaveBeenCalled();
});
test.each([
  'failed',
  'succeeded',
])('a terminal %s result without cleanup work never republishes', async state => {
  const saved = { ...operation, state };
  const mock = fixture(saved);
  expect(
    await reconcileProductMutation(
      mock.db,
      mockEnv(),
      'owner',
      'draft',
      'operation',
    ),
  ).toEqual(saved);
  expect(mock.calls.some(call => call.method === 'update')).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
