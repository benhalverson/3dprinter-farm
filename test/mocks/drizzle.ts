type TestMocks = {
  drizzle: {
    mockWhere: any;
    mockAll: any;
    mockInsert: any;
    mockUpdate: any;
    mockDelete: any;
    mockQuery: {
      cart: {
        findFirst: any;
        findMany: any;
      };
    };
    capturedInserts: unknown[];
  };
};

const testGlobals = globalThis as typeof globalThis & {
  __testMocks?: TestMocks;
};

if (!testGlobals.__testMocks) {
  throw new Error('Expected drizzle mocks to be initialized in test/setup.ts');
}

export function mockDrizzle() {
  // Mocks are initialized in test/setup.ts before test modules load.
}

export const mockWhere = testGlobals.__testMocks.drizzle.mockWhere;
export const mockAll = testGlobals.__testMocks.drizzle.mockAll;
export const mockInsert = testGlobals.__testMocks.drizzle.mockInsert;
export const mockUpdate = testGlobals.__testMocks.drizzle.mockUpdate;
export const mockDelete = testGlobals.__testMocks.drizzle.mockDelete;
export const mockQuery = testGlobals.__testMocks.drizzle.mockQuery;
export const capturedInserts = testGlobals.__testMocks.drizzle.capturedInserts;
