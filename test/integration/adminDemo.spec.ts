import { beforeEach, expect, test, vi } from 'vitest';
import app from '../../src/app';
import { mockBetterAuth } from '../mocks/auth';
import { mockEnv } from '../mocks/env';
import { scriptedDatabase } from '../mocks/scriptedDatabase';

const boundary = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('drizzle-orm/d1', () => ({ drizzle: () => boundary.db }));
const request = (action: string) =>
  app.request(
    `/admin/product-drafts${action}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=mock' },
      body: JSON.stringify({ target: { kind: 'new' } }),
    },
    mockEnv(),
  );
beforeEach(() => {
  vi.mocked(fetch).mockClear();
});
test.each([
  '',
  '/11111111-1111-4111-8111-111111111111/submit',
  '/11111111-1111-4111-8111-111111111111/reconcile',
])('anonymous %s cannot reach database or provider work', async path => {
  const mock = scriptedDatabase();
  boundary.db = mock.db;
  mockBetterAuth.getSession.mockResolvedValue(null);
  expect((await request(path)).status).toBe(401);
  expect(mock.calls).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});
test.each([
  'member',
  'user',
])('a mocked %s membership cannot publish', async role => {
  const mock = scriptedDatabase({
    role,
    userId: 'user_123',
    organizationId: 'org_shared_catalog',
  });
  boundary.db = mock.db;
  mockBetterAuth.getSession.mockResolvedValue({
    session: { id: 'session', expiresAt: new Date(Date.now() + 60000) },
    user: {
      id: 'user_123',
      email: 'member@example.test',
      name: 'Member',
      role: 'admin',
    },
  });
  expect(
    (await request('/11111111-1111-4111-8111-111111111111/submit')).status,
  ).toBe(403);
  expect(
    mock.calls.some(call =>
      ['insert', 'update', 'delete'].includes(call.method),
    ),
  ).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
