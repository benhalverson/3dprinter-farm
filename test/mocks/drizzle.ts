import { vi } from 'vitest';

export const mockWhere = vi.fn();
export const mockAll = vi.fn();
export const mockInsert = vi.fn();
export const mockUpdate = vi.fn();
export const mockDelete = vi.fn();
export const mockQuery = {
  cart: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
};

// Capture payloads passed to insert().values(...) for assertions in tests
export const capturedInserts: unknown[] = [];

export function mockDrizzle() {
  vi.mock('drizzle-orm/d1', () => {
    const whereResult = {
      all: mockAll,
      get: vi.fn().mockResolvedValue(undefined),
      orderBy: vi.fn(() => ({
        all: mockAll,
      })),
    };

    return {
      drizzle: vi.fn(() => ({
        select: () => ({
          from: () => ({
            where: mockWhere.mockReturnValue(whereResult),
            all: mockAll,
            get: vi.fn().mockResolvedValue(undefined),
            leftJoin: () => ({
              where: mockWhere.mockReturnValue(whereResult),
            }),
            innerJoin: () => ({
              where: mockWhere.mockReturnValue(whereResult),
            }),
          }),
        }),
        insert: () => ({
          values: (payload: unknown) => {
            capturedInserts.push(payload);
            return {
              onConflictDoUpdate: vi.fn().mockResolvedValueOnce(undefined),
              returning: mockInsert,
            };
          },
        }),
        update: () => ({
          set: () => ({
            where: () => ({
              returning: mockUpdate,
            }),
          }),
        }),
        delete: () => ({
          where: () => mockDelete,
        }),
        query: mockQuery,
      })),
    };
  });
}
