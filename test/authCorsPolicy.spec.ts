import { expect, test, vi } from 'vitest';
import * as authModule from '../lib/auth';
import app from '../src/app';
import { mockEnv } from './mocks/env';

vi.unmock('../lib/auth');

const admin = 'https://rc-admin.benhalverson.workers.dev';

test.each([
  { origin: admin, status: 401 },
  { origin: 'https://rc-admin.benhalverson.workers.dev.evil.example', status: 403 },
  { origin: 'https://untrusted.workers.dev', status: 403 },
])('real Better Auth origin policy on native mounted route: $origin', async ({ origin, status }) => {
  const env = mockEnv();
  env.AUTH_BASE_URL = 'https://3dprinter-web-api.benhalverson.workers.dev';
  const auth = authModule.createAuth(env.DB, env);
  const factory = vi.spyOn(authModule, 'createAuth').mockReturnValue(auth);
  const context = await auth.$context;
  // No database or credentials: reaching the unknown-user lookup proves origin acceptance.
  const lookup = vi.spyOn(context.internalAdapter, 'findUserByEmail').mockResolvedValue(null);
  const response = await app.request(`${env.AUTH_BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'controlled@example.com', password: 'controlled-invalid-password' }),
  }, env);
  expect(response.status).toBe(status);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(status === 401 ? origin : null);
  expect(response.headers.get('Vary')).toContain('Origin');
  if (status === 401) expect(lookup).toHaveBeenCalled();
  else expect(lookup).not.toHaveBeenCalled();
  lookup.mockRestore();
  factory.mockRestore();
});
