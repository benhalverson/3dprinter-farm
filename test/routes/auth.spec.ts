import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/index';
import type { Bindings } from '../../src/types';
import { mockAuth, mockBetterAuth } from '../mocks/auth';
import { mockDrizzle } from '../mocks/drizzle';

mockAuth();
mockDrizzle();

function mockEnv() {
  return {
    DB: {} as Bindings['DB'],
    JWT_SECRET: 'test-secret',
    BETTER_AUTH_SECRET: 'test-secret-key-minimum-32-characters-long',
    RATE_LIMIT_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
  } as Bindings;
}

describe('Auth Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('POST /auth/signup creates a new user', async () => {
    const request = new Request('http://localhost/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'user@example.com',
        password: 'securepassword123',
      }),
    });

    const res = await app.fetch(request, mockEnv());
    expect(res.status).toBe(200);

    const json = (await res.json()) as { message: string };
    expect(json.message).toMatch(/success/i);
    expect(mockBetterAuth.signUpEmail).toHaveBeenCalled();

    const setCookieHeader = res.headers.get('set-cookie');
    expect(setCookieHeader).toContain('better-auth.session_token=mock-session-token');
  });

  test('POST /auth/signin returns success and session cookie', async () => {
    const request = new Request('http://localhost/auth/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'user@example.com',
        password: 'securepassword123',
      }),
    });

    const res = await app.fetch(request, mockEnv());
    expect(res.status).toBe(200);

    const json = (await res.json()) as { message: string };
    expect(json.message).toMatch(/success/i);
    expect(res.headers.get('set-cookie')).toContain('better-auth.session_token');
  });

  test('POST /auth/signin propagates Better Auth failures', async () => {
    mockBetterAuth.handler.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Invalid credentials' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const request = new Request('http://localhost/auth/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'user@example.com',
        password: 'wrong-password',
      }),
    });

    const res = await app.fetch(request, mockEnv());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid credentials' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('POST /auth/signup returns non-2xx when session creation fails', async () => {
    mockBetterAuth.handler.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Session creation failed' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const request = new Request('http://localhost/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'user@example.com',
        password: 'securepassword123',
      }),
    });

    const res = await app.fetch(request, mockEnv());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Session creation failed' });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('GET /auth/signout clears the session cookie', async () => {
    const request = new Request('http://localhost/auth/signout', {
      method: 'GET',
      headers: { Cookie: 'better-auth.session_token=mock-session-token' },
    });

    const res = await app.fetch(request, mockEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
