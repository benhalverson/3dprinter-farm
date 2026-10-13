import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/d1';
import { chromium, webkit, type Browser, type Page } from 'playwright';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { z } from 'zod';
import { createAuth } from '../../lib/auth';
import app from '../../src/app';
import { mockEnv } from '../mocks/env';
import { createHttpsProxy } from './httpsProxy';
import { luluDatabase, selection } from './luluDatabase';

vi.unmock('../../lib/auth');
const records = vi.hoisted(() => ({
  users: [] as Record<string, unknown>[],
  account: [] as Record<string, unknown>[],
  session: [] as Record<string, unknown>[],
}));
vi.mock('better-auth/adapters/drizzle', async () => {
  const { memoryAdapter } = await import('better-auth/adapters/memory');
  return { drizzleAdapter: () => memoryAdapter(records) };
});

const clientRevision = 'dba226387e9a58a441be13a19c1c7ed02bea2c5f';
const storefront = 'https://luluspeedworks.com';
const api = 'https://api.luluspeedworks.com';
const storageKey = `lulu-cart-v2:${api}`;
const password = 'synthetic-native-cart-password';
const assets = new Map<string, Buffer>();
const types: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

beforeAll(() => {
  if (!process.env.LULU_CLIENT_DIR)
    throw Error(
      'Set LULU_CLIENT_DIR to the pinned Lulu checkout described in README.md',
    );
  const directory = resolve(process.env.LULU_CLIENT_DIR);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', directory, ...args], {
      encoding: 'utf8',
    }).trim();
  expect(git('rev-parse', 'HEAD')).toBe(clientRevision);
  expect(git('status', '--porcelain')).toBe('');
  // Build here, after verifying the source, so stale assets cannot pass acceptance.
  execFileSync('pnpm', ['build'], {
    cwd: directory,
    env: { ...process.env, VITE_API_ORIGIN: api },
    stdio: 'pipe',
  });
  function collect(directory: string, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) collect(join(directory, entry.name), name);
      else assets.set(name, readFileSync(join(directory, entry.name)));
    }
  }
  collect(join(directory, 'dist'));
});

/** Native browser fetch; cookies, preflights and caching are never intercepted. */
async function request(
  page: Page,
  path: string,
  method = 'GET',
  body?: object,
  token?: string,
) {
  return page.evaluate(
    async ({ url, method, body, token }) => {
      const init = {
        method,
        credentials: 'include' as const,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { 'X-Cart-Token': token } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      };
      const response = await fetch(url, init);
      return {
        status: response.status,
        body: await response.json().catch(() => null),
      };
    },
    { url: `${api}${path}`, method, body, token },
  );
}

async function credentials(
  page: Page,
  email: string,
  signup = false,
  destination = '/cart',
) {
  await page.goto(
    `${storefront}/${signup ? 'signup' : 'signin'}?returnTo=${encodeURIComponent(destination)}`,
  );
  if (signup)
    await page.getByLabel('Name', { exact: true }).fill('Native shopper');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page
    .getByRole('button', {
      name: signup ? 'Create account' : 'Sign in with password',
      exact: true,
    })
    .click();
  await page.waitForURL(`${storefront}${destination}`);
}

async function signout(page: Page) {
  await page.goto(`${storefront}/signin?returnTo=%2Fcart`);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL(`${storefront}/`);
}

for (const engine of [chromium, webkit]) {
  describe(engine.name(), () => {
    let browser: Browser;
    let proxy: Awaited<ReturnType<typeof createHttpsProxy>> | undefined;
    beforeAll(async () => {
      browser = await engine.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    beforeEach(() => {
      for (const key of Object.keys(records))
        records[key as keyof typeof records] = [];
      vi.clearAllMocks();
    });
    afterEach(async () => {
      await Promise.all(browser.contexts().map(context => context.close()));
      await proxy?.close();
      proxy = undefined;
    });

    test.each([
      { entry: 'signup', signup: true },
      { entry: 'password signin', signup: false },
    ])('$entry retains a guest bag through the pinned UI, expiry and account isolation', async ({
      signup,
    }) => {
      const database = luluDatabase();
      vi.mocked(drizzle).mockReturnValue(database.db);
      const env = mockEnv();
      env.DB = database.binding;
      env.AUTH_BASE_URL = api;
      env.RP_ID = 'rc-store.benhalverson.dev';
      env.PASSKEY_ORIGIN = 'https://rc-store.benhalverson.dev';
      env.RATE_LIMIT_KV = {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn(),
      } as unknown as KVNamespace;
      env.COLOR_CACHE = {
        get: vi.fn().mockResolvedValue(
          JSON.stringify({
            success: true,
            data: [
              {
                publicId: selection.filamentId,
                profile: 'PLA',
                hexValue: '#ff0000',
                color: 'red',
                provider: 'Slant 3D',
                available: true,
              },
            ],
          }),
        ),
      } as unknown as KVNamespace;
      const responses: { request: Request; response: Response }[] = [];
      proxy = await createHttpsProxy([storefront, api], async input => {
        const url = new URL(input.url);
        if (url.origin === storefront) {
          const name = assets.has(url.pathname) ? url.pathname : '/index.html';
          return new Response(assets.get(name), {
            headers: {
              'Content-Type':
                types[extname(name)] ?? 'application/octet-stream',
            },
          });
        }
        // Session lookup only selects the scripted D1 fixture. The production
        // middleware independently verifies that same signed cookie again.
        const session = await createAuth(env.DB, env).api.getSession({
          headers: input.headers,
        });
        const response = await database.run(input, session?.user.id, () =>
          app.fetch(input, env),
        );
        responses.push({ request: input, response });
        return response.clone();
      });
      const context = await browser.newContext({
        proxy: { server: proxy.url },
        ignoreHTTPSErrors: true,
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(storefront);
      if (!signup) {
        // Create the existing account through BetterAuth before starting the
        // anonymous shopping journey; the claim still uses the sign-in UI.
        expect(
          await request(page, '/api/auth/sign-up/email', 'POST', {
            name: 'Native shopper',
            email: 'alice@native.example',
            password,
          }),
        ).toMatchObject({ status: 200 });
        await signout(page);
      }

      // Create and populate the guest cart through the native API, then seed
      // only its browser pointer. The subsequent handoff runs through real UI.
      const created = await request(page, '/cart/create', 'POST', {
        expectedUserId: null,
      });
      expect(created.status).toBe(201);
      const { cartId, guestToken } = z
        .object({ cartId: z.string().uuid(), guestToken: z.string().uuid() })
        .parse(created.body);
      expect(
        await request(
          page,
          '/cart/add',
          'POST',
          { cartId, ...selection },
          guestToken,
        ),
      ).toMatchObject({ status: 200 });
      await page.evaluate(
        ({ storageKey, cartId, guestToken }) =>
          localStorage.setItem(
            storageKey,
            JSON.stringify({
              cartId,
              guestToken,
              ownerId: null,
              pending: false,
              revision: crypto.randomUUID(),
            }),
          ),
        { storageKey, cartId, guestToken },
      );
      await page.goto(`${storefront}/cart`);
      await page.getByText('Native guest part', { exact: true }).waitFor();

      await credentials(page, 'alice@native.example', signup);
      await page.getByRole('dialog', { name: 'Your bag' }).waitFor();
      await page.getByText('Native guest part', { exact: true }).waitFor();
      const alice = database.cart()?.userId;
      expect(alice).toBeTruthy();
      expect(
        await page.evaluate(
          key => JSON.parse(localStorage.getItem(key) ?? 'null'),
          storageKey,
        ),
      ).toMatchObject({ cartId, ownerId: alice });
      expect(
        await page.evaluate(
          key => JSON.parse(localStorage.getItem(key) ?? 'null').guestToken,
          storageKey,
        ),
      ).toBeUndefined();
      const cookie = (await context.cookies(api)).find(cookie =>
        cookie.name.endsWith('session_token'),
      );
      expect(cookie).toMatchObject({
        domain: 'api.luluspeedworks.com',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      });
      expect(await context.cookies(storefront)).toEqual([]);

      await page
        .getByRole('button', { name: 'Increase Native guest part quantity' })
        .click();
      await page.getByText(/Quantity: 2/).waitFor();
      expect(database.quantity()).toBe(2);
      await page.reload();
      await page.getByText(/Quantity: 2/).waitFor();

      const beforeExpiryWrites = database.writes.length;
      for (const session of records.session)
        session.expiresAt = new Date(Date.now() - 1_000);
      await page
        .getByRole('button', { name: 'Refresh bag', exact: true })
        .click();
      await page
        .getByText('Native guest part', { exact: true })
        .waitFor({ state: 'hidden' });
      await credentials(page, 'alice@native.example');
      await page.getByText(/Quantity: 2/).waitFor();
      expect(database.writes).toHaveLength(beforeExpiryWrites);
      await signout(page);
      expect(
        (await context.cookies(api)).filter(cookie =>
          cookie.name.endsWith('session_token'),
        ),
      ).toEqual([]);

      // A different account uses the same browser/cache and cannot see Alice's
      // private bag. Tampering with body ownership or the revoked token fails.
      await credentials(page, 'bob@native.example', true);
      await page
        .getByText('Your bag is ready for a project.', { exact: true })
        .waitFor();
      expect(
        await page.getByText('Native guest part', { exact: true }).count(),
      ).toBe(0);
      const bob = records.users.find(
        user => user.email === 'bob@native.example',
      )?.id;
      expect(bob).toBeTruthy();
      const beforeDenialWrites = database.writes.length;
      expect((await request(page, `/cart/${cartId}`)).status).toBe(404);
      const payload = {
        cartId,
        itemId: 91,
        ...selection,
        quantity: 9,
        userId: alice,
        ownerId: alice,
      };
      for (const [path, method] of [
        [`/cart/${cartId}`, 'GET'],
        ['/cart/add', 'POST'],
        ['/cart/update', 'PUT'],
        ['/cart/remove', 'DELETE'],
      ]) {
        expect(
          (
            await request(
              page,
              path,
              method,
              method === 'GET' ? undefined : payload,
              guestToken,
            )
          ).status,
        ).toBe(404);
      }
      expect(
        (
          await request(
            page,
            `/cart/${cartId}/claim`,
            'POST',
            { expectedUserId: bob },
            guestToken,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await request(
            page,
            `/cart/${cartId}/claim`,
            'POST',
            { expectedUserId: alice },
            guestToken,
          )
        ).status,
      ).toBe(409);
      expect(database.writes).toHaveLength(beforeDenialWrites);
      expect(database.cart()?.userId).toBe(alice);
      expect(database.quantity()).toBe(2);
      await signout(page);
      expect(
        (await request(page, `/cart/${cartId}`, 'GET', undefined, guestToken))
          .status,
      ).toBe(404);
      await credentials(page, 'alice@native.example', false, '/cart/');
      await page.getByText(/Quantity: 2/).waitFor();
      expect(
        await page.getByText('Product not found.', { exact: true }).count(),
      ).toBe(0);

      const claims = responses.filter(
        item =>
          new URL(item.request.url).pathname.endsWith('/claim') &&
          item.request.method === 'POST',
      );
      expect(claims.filter(item => item.response.ok)).toHaveLength(1);
      expect(
        responses.some(
          item =>
            item.request.method === 'OPTIONS' &&
            item.request.headers
              .get('access-control-request-headers')
              ?.includes('x-cart-token'),
        ),
      ).toBe(true);
      for (const { request: input, response } of responses.filter(item =>
        new URL(item.request.url).pathname.startsWith('/cart/'),
      )) {
        expect(response.headers.get('cache-control')).toBe('private, no-store');
        expect(response.headers.get('vary')).toContain('Cookie');
        expect(response.headers.get('vary')).toContain('X-Cart-Token');
        expect(response.headers.get('access-control-allow-origin')).toBe(
          storefront,
        );
        expect(response.headers.get('access-control-allow-credentials')).toBe(
          'true',
        );
        if (input.method === 'OPTIONS') expect(response.status).toBe(204);
      }
      expect(
        responses.some(
          item =>
            new URL(item.request.url).pathname === '/api/auth/sign-out' &&
            item.request.method === 'POST',
        ),
      ).toBe(true);
      expect(database.failures).toEqual([]);
      expect(proxy.failures).toEqual([]);
      expect(pageErrors).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
}
