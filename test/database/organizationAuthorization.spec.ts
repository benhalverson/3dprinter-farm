import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createAuth } from '../../lib/auth';
import * as schema from '../../src/db/schema';
import factory from '../../src/factory';
import authApi from '../../src/routes/authApi';
import { authMiddleware, requireCatalogMutationRole } from '../../src/utils/authMiddleware';
import { createDisposableDatabase } from './disposableDatabase';

let fixture: Awaited<ReturnType<typeof createDisposableDatabase>>;
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => fixture.db }));
const env = {
  DB: {} as D1Database, AUTH_BASE_URL: 'http://localhost:8787',
  BETTER_AUTH_SECRET: 'fixture-only-secret-at-least-32-characters',
};
const app = factory.createApp().route('/api/auth', authApi)
  .get('/protected', authMiddleware, requireCatalogMutationRole, c => c.json({ ok: true }));
const auth = () => createAuth(env.DB, env);
let ownerCookie: string;
let instance: ReturnType<typeof auth>;
async function signup(id: string, role: string) {
  const response = await instance.handler(new Request('http://localhost:8787/api/auth/sign-up/email', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${id}@example.com`, password: 'fixture-password', name: id }),
  }));
  expect(response.status).toBe(200);
  const { user } = await response.json() as { user: { id: string } };
  await fixture.db.update(schema.users).set({ role }).where(eq(schema.users.id, user.id));
  return { id: user.id, cookie: response.headers.get('set-cookie')!.split(';')[0] };
}
async function member(userId: string, role: string, organizationId = 'org_shared_catalog') {
  await fixture.db.insert(schema.memberTable).values({ id: `member-${userId}`, userId, organizationId, role, createdAt: new Date() });
}
function get(path: string, cookie: string) {
  return app.request(path, { headers: { cookie } }, env as never);
}
beforeAll(async () => {
  fixture = await createDisposableDatabase();
  instance = auth();
  await fixture.db.insert(schema.organizationTable).values([
    { id: 'org_shared_catalog', name: 'Staff', slug: 'staff', createdAt: new Date() },
    { id: 'unrelated', name: 'Other', slug: 'other', createdAt: new Date() },
  ]);
  const owner = await signup('owner-fixture', 'owner');
  ownerCookie = owner.cookie;
  await member(owner.id, 'owner');
});
afterAll(async () => { await fixture?.close(); });

test.each(['admin', 'catalog_manager', 'owner', 'user'])('revocation persists after plugin leave despite legacy %s role', async role => {
  const target = await signup(`legacy-${role}`, role);
  await member(target.id, 'admin');
  expect((await get('/protected', target.cookie)).status).toBe(200);
  await instance.api.updateMemberRole({ headers: new Headers({ cookie: ownerCookie }), body: {
    organizationId: 'org_shared_catalog', memberId: `member-${target.id}`, role: 'member',
  } });
  expect((await get('/protected', target.cookie)).status).toBe(403);
  // Exercise actual plugin leave with real persistence, including historical callers.
  const leave = await instance.handler(new Request('http://localhost:8787/api/auth/organization/leave', {
    method: 'POST', headers: { cookie: target.cookie, origin: 'http://localhost:8787', 'content-type': 'application/json' },
    body: JSON.stringify({ organizationId: 'org_shared_catalog' }),
  }));
  expect(leave.status).toBe(200);
  expect((await get('/protected', target.cookie)).status).toBe(403);
  expect(await fixture.db.select().from(schema.memberTable).where(and(
    eq(schema.memberTable.userId, target.id), eq(schema.memberTable.organizationId, 'org_shared_catalog'),
  )).get()).toBeUndefined();
});

test('directory denies customers and unrelated staff without disclosing fixture identities; staff can paginate', async () => {
  const customer = await signup('customer-fixture', 'user');
  await member(customer.id, 'member');
  const unrelated = await signup('unrelated-fixture', 'admin');
  await member(unrelated.id, 'admin', 'unrelated');
  for (const endpoint of ['list-members', 'get-full-organization']) {
    for (const cookie of [customer.cookie, unrelated.cookie]) {
      const response = await get(`/api/auth/organization/${endpoint}?organizationId=org_shared_catalog&limit=1&offset=1`, cookie);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('{"error":"Forbidden"}');
    }
    expect((await get(`/api/auth/organization/${endpoint}?organizationId=org_shared_catalog&limit=1&offset=1`, ownerCookie)).status).toBe(200);
  }
});
