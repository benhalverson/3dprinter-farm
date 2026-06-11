import type { DrizzleMocks, TestMocks } from './types';

const testGlobals = globalThis as typeof globalThis & {
  __testMocks?: TestMocks;
};

if (!testGlobals.__testMocks) {
  throw new Error('Expected drizzle mocks to be initialized in test/setup.ts');
}

export function mockDrizzle() {
  // Mocks are initialized in test/setup.ts before test modules load.
}

const drizzleMocks: DrizzleMocks = testGlobals.__testMocks.drizzle;

export const mockWhere = drizzleMocks.mockWhere;
export const mockAll = drizzleMocks.mockAll;
export const mockInsert = drizzleMocks.mockInsert;
export const mockUpdate = drizzleMocks.mockUpdate;
export const mockDelete = drizzleMocks.mockDelete;
export const mockQuery = drizzleMocks.mockQuery;
export const capturedInserts = testGlobals.__testMocks.drizzle.capturedInserts;
