import { chromium, webkit, type Browser, type Page } from 'playwright';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/app';
import { users } from '../../src/db/schema';
import { mockWhere } from '../mocks/drizzle';
import { mockEnv } from '../mocks/env';
import { createHttpsProxy } from './httpsProxy';

vi.unmock('../../lib/auth');
const records = vi.hoisted(() => ({
  users: [] as Record<string, unknown>[],
  account: [] as Record<string, unknown>[],
  session: [] as Record<string, unknown>[],
}));
// Only storage is substituted: production auth options, password hashing,
// cookie signatures, expiration, routes and middleware execute unchanged.
vi.mock('better-auth/adapters/drizzle', async () => {
  const { memoryAdapter } = await import('better-auth/adapters/memory');
  return { drizzleAdapter: () => memoryAdapter(records) };
});

const storefront = 'https://luluspeedworks.com';
const api = 'https://api.luluspeedworks.com';
const unrelated = 'https://luluspeedworks.com.evil.example';
const password = 'synthetic-browser-password';
const sessionUser = z.object({ user: z.object({ id: z.string() }) });

/** Executes fetch in the browser so its credential and CORS rules apply. */
function browserRequest(page: Page, path: string, options: {
  method?: string;
  body?: object;
  credentials?: 'include' | 'omit';
  apiOrigin?: string;
} = {}) {
  return page.evaluate(async ({ url, options }) => {
    try {
      const init = {
        method: options.method ?? 'GET',
        credentials: options.credentials ?? 'include',
        ...(options.body ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options.body),
        } : {}),
      };
      const response = await fetch(url, init);
      return { status: response.status, body: await response.json().catch(() => null), failed: false };
    } catch {
      return { status: 0, body: null, failed: true };
    }
  }, { url: `${options.apiOrigin ?? api}${path}`, options });
}

for (const engine of [chromium, webkit]) {
  describe(engine.name(), () => {
    let browser: Browser;
    let proxy: Awaited<ReturnType<typeof createHttpsProxy>> | undefined;
    beforeAll(async () => { browser = await engine.launch(); });
    afterAll(async () => { await browser?.close(); });
    beforeEach(() => {
      for (const key of Object.keys(records)) records[key as keyof typeof records] = [];
      vi.clearAllMocks();
    });
    afterEach(async () => {
      await Promise.all(browser.contexts().map(context => context.close()));
      await proxy?.close();
      proxy = undefined;
    });

    async function fixture() {
      const env = mockEnv();
      env.AUTH_BASE_URL = api;
      env.RP_ID = 'rc-store.benhalverson.dev';
      env.PASSKEY_ORIGIN = 'https://rc-store.benhalverson.dev';
      env.RATE_LIMIT_KV = {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      } as unknown as KVNamespace;
      const responses: { request: Request; response: Response }[] = [];
      proxy = await createHttpsProxy([storefront, unrelated, api, 'https://api.benhalverson.dev'], async request => {
        const url = new URL(request.url);
        if ([storefront, unrelated].includes(url.origin) && url.pathname === '/') {
          return new Response('<!doctype html><title>Auth acceptance fixture</title>', { headers: { 'Content-Type': 'text/html' } });
        }
        if ([api, 'https://api.benhalverson.dev'].includes(url.origin)) {
          const response = await app.fetch(request, env);
          responses.push({ request, response });
          return response.clone();
        }
        return new Response(null, { status: 404 });
      });
      const context = await browser.newContext({
        proxy: { server: proxy.url },
        ignoreHTTPSErrors: true, // The ephemeral loopback certificate is self-signed.
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      await page.goto(storefront);
      return { context, page, responses };
    }

    test('signup, password signin, profile, expiry, and POST signout retain private sessions', async () => {
      const { context, page, responses } = await fixture();
      const email = 'first@browser.example';
      const signup = await browserRequest(page, '/auth/signup', {
        method: 'POST', body: { email, password, name: 'First customer' },
      });
      expect(signup.status).toBe(200);
      const userId = sessionUser.parse(signup.body).user.id;
      const sessionCookie = (await context.cookies(api)).find(cookie => cookie.name.endsWith('session_token'));
      expect(sessionCookie).toMatchObject({
        domain: 'api.luluspeedworks.com', path: '/', secure: true, httpOnly: true, sameSite: 'None',
      });
      expect(await context.cookies(storefront)).toEqual([]);
      expect(await page.evaluate('document.cookie')).toBe('');

      // Profile still queries the production Drizzle expression for the identity
      // from the verified cookie; only the returned profile row is a fixture.
      mockWhere.mockResolvedValueOnce([{ id: userId, email }]);
      const profile = await browserRequest(page, '/profile');
      expect(profile.status).toBe(200);
      expect(profile.body).toMatchObject({ id: userId, email });
      expect(mockWhere).toHaveBeenLastCalledWith(eq(users.id, userId));
      expect((await browserRequest(page, '/profile', { credentials: 'omit' })).status).toBe(401);
      expect((await browserRequest(page, '/profile', { apiOrigin: 'https://api.benhalverson.dev' })).status).toBe(401);

      await page.reload();
      expect(sessionUser.parse((await browserRequest(page, '/api/auth/get-session')).body).user.id).toBe(userId);
      expect((await browserRequest(page, '/auth/signout')).status).toBe(404);
      expect(sessionUser.parse((await browserRequest(page, '/api/auth/get-session')).body).user.id).toBe(userId);
      expect((await browserRequest(page, '/auth/signout', { method: 'POST' })).status).toBe(200);
      expect(records.session).toHaveLength(0);
      expect((await context.cookies(api)).filter(cookie => cookie.name.endsWith('session_token'))).toEqual([]);
      expect((await browserRequest(page, '/profile')).status).toBe(401);

      expect((await browserRequest(page, '/auth/signin', {
        method: 'POST', body: { email, password: 'wrong-password' },
      })).status).toBe(401);
      expect((await browserRequest(page, '/auth/signin', {
        method: 'POST', body: { email, password },
      })).status).toBe(200);
      expect(sessionUser.parse((await browserRequest(page, '/api/auth/get-session')).body).user.id).toBe(userId);

      // Expire the server-side fixture while keeping the signed browser cookie.
      // Better Auth, rather than the fixture, decides that this session is invalid.
      expect(records.session).toHaveLength(1);
      records.session[0].expiresAt = new Date(Date.now() - 1_000);
      expect((await browserRequest(page, '/profile')).status).toBe(401);
      expect((await browserRequest(page, '/api/auth/get-session')).body).toBeNull();

      const otherEmail = 'second@browser.example';
      const other = await browserRequest(page, '/auth/signup', {
        method: 'POST', body: { email: otherEmail, password, name: 'Second customer' },
      });
      expect(other.status).toBe(200);
      const otherId = sessionUser.parse(other.body).user.id;
      expect(otherId).not.toBe(userId);
      mockWhere.mockResolvedValueOnce([{ id: otherId, email: otherEmail }]);
      const otherProfile = await browserRequest(page, '/profile');
      expect(otherProfile.status).toBe(200);
      expect(otherProfile.body).toMatchObject({ id: otherId, email: otherEmail });
      expect(mockWhere).toHaveBeenLastCalledWith(eq(users.id, otherId));

      const observer = await context.newPage();
      await observer.goto(unrelated);
      expect((await browserRequest(observer, '/profile')).failed).toBe(true);
      expect((await browserRequest(observer, '/auth/signout', { method: 'POST' })).failed).toBe(true);
      expect((await browserRequest(observer, '/auth/signup', {
        method: 'POST', body: { email: 'rejected@browser.example', password, name: 'Rejected' },
      })).failed).toBe(true);
      expect(records.users).toHaveLength(2);
      expect(records.session).toHaveLength(1);
      expect(sessionUser.parse((await browserRequest(page, '/api/auth/get-session')).body).user.id).toBe(otherId);

      const preflight = responses.filter(({ request }) => request.method === 'OPTIONS');
      expect(preflight.length).toBeGreaterThan(0);
      expect(preflight.some(({ request }) => request.headers.get('origin') === unrelated)).toBe(true);
      for (const { request, response } of preflight) {
        expect(request.headers.get('access-control-request-method')).toBe('POST');
        if (request.headers.get('origin') === unrelated) {
          expect(response.status).toBe(403);
          expect(response.headers.get('access-control-allow-origin')).toBeNull();
          continue;
        }
        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-methods')).toContain('POST');
        expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('content-type');
      }
      for (const { request, response } of responses) {
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        const vary = response.headers.get('vary')?.split(',').map(value => value.trim());
        expect(vary).toEqual(expect.arrayContaining(['Origin', 'Cookie', 'Authorization', 'X-Cart-Token']));
        if (request.headers.get('origin') === unrelated) {
          expect(response.status).toBe(403);
          expect(response.headers.get('access-control-allow-origin')).toBeNull();
        } else if (request.headers.get('origin') === storefront) {
          expect(response.headers.get('access-control-allow-origin')).toBe(storefront);
          expect(response.headers.get('access-control-allow-credentials')).toBe('true');
        }
      }
      expect(responses.some(({ request }) => request.method === 'POST'
        && new URL(request.url).pathname === '/auth/signup'
        && request.headers.get('origin') === unrelated)).toBe(false);
      expect(proxy?.failures).toEqual([]);
    });
  });
}
