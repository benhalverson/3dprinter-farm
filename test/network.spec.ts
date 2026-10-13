import net from 'node:net';
import { expect, it, vi } from 'vitest';

it('fails an unmocked provider request before opening a connection', async () => {
  await expect(fetch('https://provider.invalid/unmocked')).rejects.toThrow(
    'Unexpected network request',
  );
});

it('blocks direct sockets even after restoring test spies', () => {
  vi.restoreAllMocks();
  expect(() => new net.Socket().connect(443, 'provider.invalid')).toThrow(
    'Network sockets are forbidden in tests',
  );
});
