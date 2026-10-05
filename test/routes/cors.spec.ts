import { beforeEach, expect, test, vi } from 'vitest';
import app from '../../src/app';
import { mockBetterAuth } from '../mocks/auth';
import { mockEnv } from '../mocks/env';

const admin = 'https://rc-admin.benhalverson.workers.dev';
const api = 'https://3dprinter-web-api.benhalverson.workers.dev';
const origins = [
  'http://localhost:3000', 'http://localhost:4200', 'http://localhost:8787',
  'https://rc-store.benhalverson.dev', 'https://rc-admin.pages.dev',
  'https://api.benhalverson.dev', 'https://luluspeedworks.com', admin,
];

beforeEach(() => {
  vi.clearAllMocks();
  mockBetterAuth.handler.mockReset();
});

/** Exercises the mounted application using disposable auth responses and bindings. */
function request(path: string, origin: string, init: RequestInit = {}) {
  const env = mockEnv();
  env.RATE_LIMIT_KV = { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) } as unknown as KVNamespace;
  return app.request(`${api}${path}`, {
    ...init,
    headers: { Origin: origin, ...init.headers },
  }, env);
}

/** Checks credentialed CORS and origin-dependent cache selection. */
function allowed(response: Response, origin: string) {
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  expect(response.headers.get('Vary')?.split(/,\s*/)).toContain('Origin');
}

test.each(origins)('preserves preflight and unauthorized profile CORS for %s', async origin => {
  const preflight = await request('/auth/signin', origin, {
    method: 'OPTIONS',
    headers: {
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authorization',
    },
  });
  expect(preflight.status).toBe(204);
  allowed(preflight, origin);
  expect(preflight.headers.get('Access-Control-Allow-Methods')?.split(',')).toEqual([
    'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS',
  ]);
  expect(preflight.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toBe('content-type,authorization,x-cart-token');
  expect(preflight.headers.get('Vary')).toContain('Access-Control-Request-Headers');
  expect(mockBetterAuth.handler).not.toHaveBeenCalled();
  mockBetterAuth.getSession.mockResolvedValueOnce(null);
  const profile = await request('/profile', origin);
  expect(profile.status).toBe(401);
  allowed(profile, origin);
});

test.each([200, 401, 500])('keeps CORS on mounted signin provider response %s', async status => {
  mockBetterAuth.handler.mockResolvedValueOnce(new Response(JSON.stringify(status === 200 ? {
    user: { id: 'controlled-user', email: 'test@example.com', name: 'Test', role: 'user' },
  } : { error: 'controlled failure' }), {
    status, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'controlled=session; HttpOnly; Secure; SameSite=None' },
  }));
  const response = await request('/auth/signin', admin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'controlled=session', 'CF-Connecting-IP': crypto.randomUUID() },
    body: JSON.stringify({ email: 'test@example.com', password: 'controlled-password' }),
  });
  expect(response.status).toBe(status);
  allowed(response, admin);
  if (status === 200) expect(response.headers.get('Set-Cookie')).toContain('controlled=session');
  expect(mockBetterAuth.handler.mock.calls[0][0].headers.get('origin')).toBe(admin);
});

test('keeps origin selection on the mounted health route', async () => {
  const response = await request('/health', admin);
  expect(response.status).toBe(200);
  allowed(response, admin);
});

test.each([
  'https://rc-admin.benhalverson.workers.dev.evil.example',
  'https://evil-rc-admin.benhalverson.workers.dev',
  'http://rc-admin.benhalverson.workers.dev',
  'https://untrusted.workers.dev', 'null',
])('does not grant browser access to %s', async origin => {
  const preflight = await request('/auth/signin', origin, {
    method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  expect(preflight.headers.get('Access-Control-Allow-Origin')).toBeNull();
  expect(preflight.headers.get('Vary')).toContain('Origin');
  mockBetterAuth.getSession.mockResolvedValueOnce(null);
  const response = await request('/profile', origin);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  expect(response.status).toBe(403);
  expect(response.headers.get('Vary')).toContain('Origin');
});

test('keeps CORS when the native mounted auth handler throws through onError', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  mockBetterAuth.handler.mockRejectedValueOnce(new Error('controlled auth failure'));
  const response = await request('/api/auth/get-session', admin, {
    headers: { Cookie: 'controlled=session' },
  });
  expect(response.status).toBe(500);
  allowed(response, admin);
  expect(await response.text()).toBe('Internal Server Error');
  log.mockRestore();
});
