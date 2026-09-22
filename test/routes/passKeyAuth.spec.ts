import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createExecutionContext } from 'cloudflare:test';
import app from '../../src/app';
import { mockAuth, mockBetterAuth } from '../mocks/auth';
import { mockDrizzle } from '../mocks/drizzle';
import { mockEnv } from '../mocks/env';

mockAuth();
mockDrizzle();

describe('Better Auth Passkey Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('mounts native passkey endpoints under /api/auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/auth/passkey/list-user-passkeys', {
        method: 'GET',
        headers: {
          Cookie: 'better-auth.session_token=mock-session-token',
        },
      }),
      mockEnv() as unknown as Env,
      createExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(mockBetterAuth.handler).toHaveBeenCalled();
  });

  test('passes invalid passkey registration payloads through to Better Auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/auth/passkey/verify-registration', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ response: {} }),
      }),
      mockEnv() as unknown as Env,
      createExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(mockBetterAuth.handler).toHaveBeenCalled();
  });

  test('passes valid-looking passkey registration payloads through to Better Auth', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/auth/passkey/verify-registration', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ response: { id: 'credential-id' } }),
      }),
      mockEnv() as unknown as Env,
      createExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(mockBetterAuth.handler).toHaveBeenCalled();
  });
});
