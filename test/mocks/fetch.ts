import { vi } from 'vitest';

export function mockGlobalFetch() {
  globalThis.fetch = vi.fn().mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      type: 'basic' as const,
      url: '',
      redirected: false,
      body: null,
      bodyUsed: false,
      headers: new Headers(),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(''),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      blob: () => Promise.resolve(new Blob([])),
      formData: () => Promise.resolve(new FormData()),
      clone: vi.fn(),
    } as unknown as Response),
  );
}
