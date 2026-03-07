import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/index';
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
    );

    expect(res.status).toBe(200);
    expect(mockBetterAuth.handler).toHaveBeenCalled();
  });

  test('rejects invalid passkey registration payloads before Better Auth throws', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/auth/passkey/verify-registration', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ response: {} }),
      }),
      mockEnv() as unknown as Env,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      message: 'Failed to verify registration',
      code: 'FAILED_TO_VERIFY_REGISTRATION',
      details: 'Missing credential ID',
    });
    expect(mockBetterAuth.handler).not.toHaveBeenCalled();
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
    );

    expect(res.status).toBe(200);
    expect(mockBetterAuth.handler).toHaveBeenCalled();
  });
});
