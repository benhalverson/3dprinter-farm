import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createAuth } from '../../lib/auth';
import { account } from '../../src/db/schema';
import { PASSWORD_VERSION } from '../../src/utils/crypto';
import { createDisposableDatabase } from './disposableDatabase';

let fixture: Awaited<ReturnType<typeof createDisposableDatabase>>;
// Substitute only the driver; the auth handler, adapter, SQL and persistence are real.
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => fixture.db }));
beforeAll(async () => { fixture = await createDisposableDatabase(); });
afterAll(async () => { await fixture?.close(); });

const password = 'fixture-password-123';
let resetURL = '';
function auth() {
  return createAuth({} as D1Database, {
    AUTH_BASE_URL: 'http://localhost:8787',
    AUTH_EMAIL: { send: async message => { resetURL = message.text!.match(/https?:\/\/\S+/)![0]; return { messageId: 'fixture' }; } },
    BETTER_AUTH_SECRET: 'fixture-only-secret-at-least-32-characters',
  });
}
async function request(instance: ReturnType<typeof auth>, path: string, body: object, cookie?: string) {
  return instance.handler(new Request(`http://localhost:8787/api/auth/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:8787', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }));
}

test('legacy login upgrades persistence; bad passwords cannot migrate; new login and changes work', async () => {
  const instance = auth();
  const email = 'migration@example.com';
  const signup = await request(instance, 'sign-up/email', { email, password, name: 'Fixture' });
  expect(signup.status).toBe(200);
  const row = await fixture.db.select().from(account).get();
  expect(row?.password).toContain(PASSWORD_VERSION);
  const salt = Buffer.alloc(16, 1);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, key, 32);
  const legacy = `${salt.toString('base64')}:${Buffer.from(bits).toString('base64')}`;
  await fixture.db.update(account).set({ password: legacy }).where(eq(account.id, row!.id));
  expect((await request(instance, 'sign-in/email', { email, password: 'wrong-password' })).status).toBe(401);
  expect((await fixture.db.select().from(account).get())?.password).toBe(legacy);
  const login = await request(instance, 'sign-in/email', { email, password });
  expect(login.status).toBe(200);
  const migrated = (await fixture.db.select().from(account).get())!.password!;
  expect(migrated).toContain(PASSWORD_VERSION);
  expect(Buffer.from(migrated.split(PASSWORD_VERSION)[1], 'base64')).toHaveLength(32);
  expect((await request(instance, 'sign-in/email', { email, password })).status).toBe(200);
  expect((await fixture.db.select().from(account).get())?.password).toBe(migrated);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const changed = await request(instance, 'change-password', { currentPassword: password, newPassword: 'changed-fixture-password' }, cookie);
  expect(changed.status).toBe(200);
  expect((await fixture.db.select().from(account).get())?.password).toContain(PASSWORD_VERSION);
  expect((await request(instance, 'sign-in/email', { email, password })).status).toBe(401);
  expect((await request(instance, 'sign-in/email', { email, password: 'changed-fixture-password' })).status).toBe(200);
});

test('password reset stores the new verifier and revokes prior passwords', async () => {
  const instance = auth();
  const email = 'migration@example.com';
  expect((await request(instance, 'request-password-reset', { email, redirectTo: 'http://localhost:8787/reset' })).status).toBe(200);
  const token = new URL(resetURL).pathname.split('/').at(-1);
  expect((await request(instance, 'reset-password', { token, newPassword: 'reset-fixture-password' })).status).toBe(200);
  expect((await fixture.db.select().from(account).get())?.password).toContain(PASSWORD_VERSION);
  expect((await request(instance, 'sign-in/email', { email, password: 'reset-fixture-password' })).status).toBe(200);
  expect((await request(instance, 'sign-in/email', { email, password: 'changed-fixture-password' })).status).toBe(401);
});
