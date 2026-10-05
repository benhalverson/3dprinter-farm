import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAuth } from '../lib/auth';
import { mockEnv } from './mocks/env';

vi.unmock('../lib/auth');
afterEach(() => vi.restoreAllMocks());

describe('Better Auth origin enforcement', () => {
  test.each(['https://unrelated.example', 'https://luluspeedworks.com.evil.example', 'null'])('rejects native signout from %s', async origin => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = mockEnv();
    const auth = createAuth(env.DB, env);
    const response = await auth.handler(new Request('http://localhost:8787/api/auth/sign-out', {
      method: 'POST', headers: { origin, cookie: 'better-auth.session_token=invalid' },
    }));
    expect(response.status).toBe(403);
  });

  test('accepts Lulu POST signout through the real handler without an active session', async () => {
    const env = mockEnv();
    const auth = createAuth(env.DB, env);
    const response = await auth.handler(new Request('http://localhost:8787/api/auth/sign-out', {
      method: 'POST', headers: { origin: 'https://luluspeedworks.com' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  test.each([
    ['https://luluspeedworks.com', 'https://api.luluspeedworks.com'],
    ['https://rc-admin.benhalverson.workers.dev', 'https://api.luluspeedworks.com'],
    ['https://rc-store.benhalverson.dev', 'https://api.benhalverson.dev'],
    ['https://rc-admin.benhalverson.workers.dev', 'https://api.benhalverson.dev'],
  ])('accepts %s signout at %s with the Lulu auth base and RC passkey configuration', async (origin, apiOrigin) => {
    const env = mockEnv();
    const auth = createAuth(env.DB, {
      ...env,
      AUTH_BASE_URL: 'https://api.luluspeedworks.com',
      RP_ID: 'rc-store.benhalverson.dev',
      PASSKEY_ORIGIN: 'https://rc-store.benhalverson.dev',
    });
    const response = await auth.handler(new Request(`${apiOrigin}/api/auth/sign-out`, {
      method: 'POST', headers: { origin },
    }));
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=None');
    expect(cookie).not.toMatch(/(?:^|;)\s*Domain=/i);
  });

});
