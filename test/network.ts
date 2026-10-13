import { timingSafeEqual } from 'node:crypto';
import { vi } from 'vitest';
import net from 'node:net';

// Every suite starts with a deny-by-default provider boundary. Tests must install
// explicit fetch/email mocks; an omitted mock must never reach a real service.
globalThis.fetch = vi.fn(async input => {
  throw new Error(
    `Unexpected network request: install an explicit API mock (${String(input)})`,
  );
});
Object.defineProperty(net.Socket.prototype, 'connect', {
  configurable: true,
  value: () => {
    throw new Error('Network sockets are forbidden in tests');
  },
});

// Worker-specific crypto extension backed by Node's constant-time primitive.
Object.assign(crypto.subtle, {
  timingSafeEqual: (left: ArrayBuffer, right: ArrayBuffer) =>
    timingSafeEqual(new Uint8Array(left), new Uint8Array(right)),
});
