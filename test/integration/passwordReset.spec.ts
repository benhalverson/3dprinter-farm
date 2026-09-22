import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { Hono } from 'hono';
import { Miniflare } from 'miniflare';
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { account, session, verification } from '../../src/db/schema';
import authApi, { type AuthApiEnv } from '../../src/routes/authApi';
import type { Bindings } from '../../src/types';
import { requestLogger } from '../../src/utils/requestLogger';

const origin = 'https://api.benhalverson.dev';
const callback = 'https://luluspeedworks.com/reset-password';
const email = 'customer@example.com';
const oldPassword = 'Original-password-123';
const newPassword = 'Replacement-password-456';
type Message = Parameters<Bindings['AUTH_EMAIL']['send']>[0];

describe('password reset with real Better Auth, Drizzle, D1 and KV', () => {
  let runtime: Miniflare;
  let bindings: AuthApiEnv['Bindings'];
  let db: ReturnType<typeof drizzle>;
  let tasks: Promise<unknown>[];
  const send = vi.fn<(message: Message) => Promise<{ messageId: string }>>();
  const app = new Hono<AuthApiEnv>()
    .use(requestLogger)
    .route('/api/auth', authApi);

  function request(
    path: string,
    body?: unknown,
    ip = '192.0.2.1',
    headers?: Record<string, string>,
  ) {
    return app.fetch(
      new Request(new URL(path, origin), {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          origin: new URL(callback).origin,
          'cf-connecting-ip': ip,
          ...headers,
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      }),
      bindings,
      {
        waitUntil: promise => {
          tasks.push(promise);
        },
        passThroughOnException() {},
        props: {},
      },
    );
  }

  async function register() {
    const response = await request('/api/auth/sign-up/email', {
      email,
      password: oldPassword,
      name: 'Customer',
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie');
    assert(cookie);
    return cookie.split(';')[0];
  }

  async function resetLink(redirectTo: string | undefined = callback) {
    const response = await request('/api/auth/request-password-reset', {
      email,
      redirectTo,
    });
    expect(response.status).toBe(200);
    await Promise.all(tasks);
    const call = send.mock.calls.at(-1);
    assert(call);
    const message = call[0];
    assert(message.text);
    const url = new URL(
      message.text.split('\n')[0].replace('Reset your password: ', ''),
    );
    const token = url.pathname.split('/').at(-1);
    assert(token);
    return { response, message, url, token };
  }

  beforeEach(async () => {
    tasks = [];
    send.mockReset().mockResolvedValue({ messageId: 'test-email' });
    runtime = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("test"); } }',
      compatibilityDate: '2024-10-05',
      d1Databases: ['DB'],
      kvNamespaces: ['RATE_LIMIT_KV'],
    });
    const database = await runtime.getD1Database('DB');
    // These are real Miniflare bindings, with the same runtime API as the Worker.
    bindings = {
      DB: database as D1Database,
      RATE_LIMIT_KV: (await runtime.getKVNamespace(
        'RATE_LIMIT_KV',
      )) as KVNamespace,
      AUTH_BASE_URL: origin,
      RP_ID: 'rc-store.benhalverson.dev',
      RP_NAME: '3D Printer Web API',
      PASSKEY_ORIGIN: 'https://rc-store.benhalverson.dev',
      BETTER_AUTH_SECRET: 'integration-test-secret-at-least-32-characters',
      AUTH_EMAIL: {
        send: message => {
          if (!('subject' in message))
            throw new Error('Expected structured email');
          return send(message);
        },
      },
    };
    db = drizzle(bindings.DB);
    await migrate(db, { migrationsFolder: './.wrangler/auth-test-migrations' });
  });

  afterEach(async () => {
    await Promise.all(tasks);
    await runtime.dispose();
    vi.restoreAllMocks();
  });

  it('sends the canonical link, resets once, preserves hashing, and revokes every session', async () => {
    const cookie = await register();
    expect(
      (
        await request('/api/auth/sign-in/email', {
          email,
          password: oldPassword,
        })
      ).status,
    ).toBe(200);
    expect(await db.select().from(session)).toHaveLength(2);
    const { url, token, message } = await resetLink();
    expect(message.from).toEqual({
      email: 'noreply@luluspeedworks.com',
      name: 'Lulu Speedworks',
    });
    expect(message.to).toBe(email);
    expect(message.html).toContain(url.href);
    expect(message.html).toContain('one hour');
    expect(message.text).toContain('ignore this email');
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe(`/api/auth/reset-password/${token}`);
    const [stored] = await db.select().from(verification);
    expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(3_590_000);
    expect(stored.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      3_600_000,
    );
    const redirect = await request(url.href);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe(`${callback}?token=${token}`);
    expect(
      (await request('/api/auth/reset-password', { token, newPassword }))
        .status,
    ).toBe(200);
    expect(await db.select().from(verification)).toHaveLength(0);
    expect(await db.select().from(session)).toHaveLength(0);
    expect(
      await (
        await request('/api/auth/get-session', undefined, undefined, { cookie })
      ).json(),
    ).toBeNull();
    expect(
      (
        await request('/api/auth/sign-in/email', {
          email,
          password: oldPassword,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request('/api/auth/sign-in/email', {
          email,
          password: newPassword,
        })
      ).status,
    ).toBe(200);
    expect((await db.select().from(account))[0].password).toContain(':');
    expect(
      (
        await request('/api/auth/reset-password', {
          token,
          newPassword: oldPassword,
        })
      ).status,
    ).toBe(400);
  });

  it('returns the same generic response for unknown accounts and delivery failures without leaking credentials', async () => {
    const logs = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
    ];
    await register();
    const { response, token, url } = await resetLink();
    const unknown = await request('/api/auth/request-password-reset', {
      email: 'unknown@example.com',
      redirectTo: callback,
    });
    expect(send).toHaveBeenCalledTimes(1);
    send.mockImplementationOnce(async message => {
      throw new Error(`provider echoed ${message.text} ${newPassword}`);
    });
    const failed = await request('/api/auth/request-password-reset', {
      email,
      redirectTo: callback,
    });
    await Promise.all(tasks);
    expect(unknown.status).toBe(response.status);
    expect(failed.status).toBe(response.status);
    const body = await response.json();
    expect(await unknown.json()).toEqual(body);
    expect(await failed.json()).toEqual(body);
    await request(url.href);
    const rejectedLink = new URL(url);
    rejectedLink.searchParams.set(
      'callbackURL',
      `https://evil.example/${token}`,
    );
    expect((await request(rejectedLink.href)).status).toBe(403);
    await request(`/api/auth/reset-password?token=${token}`, { newPassword });
    const output = JSON.stringify(logs.flatMap(log => log.mock.calls));
    expect(output).toContain('/api/auth/sign-up/email');
    expect(output).not.toContain('/api/auth/reset-password');
    expect(output).toContain('auth.password_reset.email_delivery_failed');
    for (const secret of [token, url.href, oldPassword, newPassword])
      expect(output).not.toContain(secret);
  });

  it('registers background delivery with waitUntil and returns before delivery completes', async () => {
    await register();
    let finish!: (value: { messageId: string }) => void;
    send.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const response = await request('/api/auth/request-password-reset', {
      email,
      redirectTo: callback,
    });
    expect(response.status).toBe(200);
    expect(tasks).toHaveLength(1);
    finish({ messageId: 'completed-in-background' });
    await Promise.all(tasks);
  });

  it('checks trusted destinations on requests and callbacks and safely escapes email HTML', async () => {
    await register();
    for (const redirectTo of [
      'https://evil.example/reset',
      'https://luluspeedworks.com.evil.example/reset',
      'javascript:alert(1)',
    ]) {
      expect(
        (
          await request('/api/auth/request-password-reset', {
            email,
            redirectTo,
          })
        ).status,
      ).toBe(403);
    }
    expect(send).not.toHaveBeenCalled();
    const destination = `${callback}?a="'><script>alert(1)</script>&b=2`;
    const { url, token, message } = await resetLink(destination);
    expect(message.html).not.toContain('<script>');
    expect(url.searchParams.get('callbackURL')).toBe(destination);
    url.searchParams.set('callbackURL', 'https://evil.example/reset');
    expect((await request(url.href)).status).toBe(403);
    expect(
      (await request('/api/auth/reset-password', { token, newPassword }))
        .status,
    ).toBe(200);
  });

  it('rejects expired and invalid tokens at the callback and password submission', async () => {
    await register();
    const { token } = await resetLink();
    await db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(verification.identifier, `reset-password:${token}`));
    for (const candidate of [token, 'invalid-token']) {
      const response = await request(
        `/api/auth/reset-password/${candidate}?callbackURL=${encodeURIComponent(callback)}`,
      );
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(
        `${callback}?error=INVALID_TOKEN`,
      );
      expect(
        (
          await request('/api/auth/reset-password', {
            token: candidate,
            newPassword,
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await request('/api/auth/sign-in/email', {
          email,
          password: oldPassword,
        })
      ).status,
    ).toBe(200);
  });

  it('allows omitted redirectTo and preserves Better Auth callback behavior', async () => {
    await register();
    const response = await request('/api/auth/request-password-reset', {
      email,
    });
    expect(response.status).toBe(200);
    await Promise.all(tasks);
    const text = send.mock.calls[0][0].text;
    assert(text);
    const url = text.split('\n')[0].replace('Reset your password: ', '');
    expect((await request(url)).headers.get('location')).toBe(
      `${origin}/api/auth/error?error=INVALID_TOKEN`,
    );
  });

  it('rejects malformed input and password lengths without consuming a valid token', async () => {
    await register();
    const { token } = await resetLink();
    for (const body of [{}, { email: 'invalid' }, '{']) {
      expect(
        (await request('/api/auth/request-password-reset', body)).status,
      ).toBe(400);
    }
    for (const body of [
      {},
      { token, newPassword: 'short' },
      { token, newPassword: 'a'.repeat(129) },
      { token, newPassword: 123 },
      '{',
    ]) {
      expect((await request('/api/auth/reset-password', body)).status).toBe(
        400,
      );
    }
    expect(
      (await request('/api/auth/reset-password', { token, newPassword }))
        .status,
    ).toBe(200);
  });

  it('uses the local AUTH_BASE_URL override instead of the incoming request host', async () => {
    bindings.AUTH_BASE_URL = 'http://localhost:8787';
    bindings.RP_ID = 'localhost';
    bindings.PASSKEY_ORIGIN = undefined;
    await register();
    const { url } = await resetLink();
    expect(url.origin).toBe('http://localhost:8787');
  });

  it.each([
    [
      '/api/auth/request-password-reset',
      5,
      { email: 'unknown@example.com' },
      'password-reset-request',
    ],
    [
      '/api/auth/reset-password',
      10,
      { token: 'invalid', newPassword },
      'password-reset-submit',
    ],
  ] as const)('limits %s per IP using KV with a 15-minute TTL', async (path, limit, body, prefix) => {
    const acceptedStatus = path.endsWith('/request-password-reset') ? 200 : 400;
    for (let i = 0; i < limit; i++)
      expect((await request(path, body)).status).toBe(acceptedStatus);
    expect((await request(path, body)).status).toBe(429);
    expect((await request(path, body, '192.0.2.2')).status).toBe(
      acceptedStatus,
    );
    const entries = await bindings.RATE_LIMIT_KV.list({
      prefix: `${prefix}:${path}:192.0.2.1`,
    });
    expect(entries.keys).toHaveLength(1);
    const expiration = entries.keys[0].expiration;
    assert(expiration);
    expect(expiration - Date.now() / 1000).toBeGreaterThan(890);
    expect(expiration - Date.now() / 1000).toBeLessThanOrEqual(900);
  });
});
