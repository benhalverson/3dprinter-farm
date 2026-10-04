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
});
