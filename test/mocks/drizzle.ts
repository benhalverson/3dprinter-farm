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
    return {
      drizzle: vi.fn(() => ({
        select: () => ({
          from: () => ({
            where: mockWhere,
            all: mockAll,
            leftJoin: () => ({
              where: mockWhere,
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
