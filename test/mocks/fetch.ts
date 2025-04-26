import { vi } from 'vitest';

export function mockGlobalFetch() {
	globalThis.fetch = vi.fn();
}
