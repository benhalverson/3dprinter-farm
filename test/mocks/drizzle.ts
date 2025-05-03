import { vi } from 'vitest';

export const mockWhere = vi.fn();
export const mockAll = vi.fn();
export const mockInsert = vi.fn();
export const mockUpdate = vi.fn();

export function mockDrizzle() {
	vi.mock('drizzle-orm/d1', () => {
		return {
			drizzle: vi.fn(() => ({
				select: () => ({
					from: () => ({
						where: mockWhere,
						all: mockAll,
					}),
				}),
				insert: () => ({
					values: () => ({
						onConflictDoUpdate: vi.fn().mockResolvedValueOnce(undefined),
						returning: mockInsert,
					}),
				}),
				update: () => ({
					set: () => ({
						where: () => ({
							returning: mockUpdate,
						}),
					}),
				}),
			})),
		};
	});
}
