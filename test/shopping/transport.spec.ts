import { env, runInDurableObject } from 'cloudflare:test';
import { EventSchemas } from '@ag-ui/core/schemas';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import app from '../../src/index';
import { IDLE_MS, LIFE_MS } from '../../src/shopping/contracts';
import { reservations } from '../../src/shopping/storage/ledger-schema';
import { runs, visits } from '../../src/shopping/storage/visit-schema';
import { mockEnv } from '../mocks/env';
import { ShoppingAgent } from './worker';

const sessionSchema = z.object({
  sessionId: z.string().uuid(),
  capability: z.string(),
  expiresAt: z.number(),
  absoluteExpiresAt: z.number(),
});
type Session = z.infer<typeof sessionSchema>;
const eventSchema = z.object({
  type: z.string(),
  runId: z.string().optional(),
  name: z.string().optional(),
  value: z
    .object({
      runId: z.string(),
      uiRevision: z.number(),
      reason: z.string().optional(),
    })
    .passthrough()
    .optional(),
});
const testEnv = () => ({
  ...mockEnv(),
  ...env,
  AGENT_NETWORK_SECRET: 'local-test-identity-secret-only-32-bytes',
});
const create = async (ip = crypto.randomUUID()) => {
  const res = await app.request(
    '/agent/sessions',
    { method: 'POST', headers: { 'cf-connecting-ip': ip } },
    testEnv(),
  );
  expect(res.status).toBe(201);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return sessionSchema.parse(await res.json());
};
const start = (session: Session, runId = crypto.randomUUID(), uiRevision = 7) =>
  app.request(
    `/agent/sessions/${session.sessionId}/runs`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.capability}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        runId,
        uiRevision,
        message: 'Show pit tools',
        context: [],
      }),
    },
    testEnv(),
  );
const cancel = (session: Session, runId: string) =>
  app.request(
    `/agent/sessions/${session.sessionId}/runs/${runId}/cancel`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.capability}` },
    },
    testEnv(),
  );
const stub = (session: Session) =>
  env.SHOPPING_AGENT.get(env.SHOPPING_AGENT.idFromName(session.sessionId));
const mode = async (session: Session, value: ShoppingAgent['mode']) =>
  runInDurableObject(stub(session), instance => {
    if (!(instance instanceof ShoppingAgent))
      throw new Error('wrong_test_entrypoint');
    instance.mode = value;
  });
const events = async (res: Response) =>
  (await res.text())
    .split('\n\n')
    .filter(Boolean)
    .map(frame =>
      eventSchema.parse(
        EventSchemas.parse(JSON.parse(frame.replace(/^data: */, ''))),
      ),
    );
const calls = async (session: Session) =>
  runInDurableObject(stub(session), instance => {
    if (!(instance instanceof ShoppingAgent))
      throw new Error('wrong_test_entrypoint');
    return instance.invocations;
  });
afterEach(() => vi.useRealTimers());

describe('anonymous shopping transport in local Workers', () => {
  it('publishes ordered AG-UI lifecycle and validated revision-tagged composition', async () => {
    const session = await create();
    expect(session.absoluteExpiresAt - session.expiresAt).toBe(
      LIFE_MS - IDLE_MS,
    );
    const runId = crypto.randomUUID();
    const response = await start(session, runId, 42);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const output = await events(response);
    expect(output[0]).toMatchObject({ type: 'RUN_STARTED', runId });
    expect(output.at(-1)).toMatchObject({ type: 'RUN_FINISHED', runId });
    const batch = output.find(event => event.name === 'lulu.a2ui.v1');
    expect(batch?.value).toMatchObject({ runId, uiRevision: 42 });
    expect(output.some(event => event.name === 'lulu.fallback.v1')).toBe(false);
    expect(await calls(session)).toBe(1);
    const duplicate = await start(session, runId, 43);
    expect(await duplicate.json()).toMatchObject({
      status: 'completed',
      runId,
      uiRevision: 42,
    });
    expect(await calls(session)).toBe(1);
    await runInDurableObject(stub(session), (_instance, ctx) => {
      const db = drizzle(ctx.storage);
      const persisted = JSON.stringify([
        db.select().from(visits).all(),
        db.select().from(runs).all(),
      ]);
      expect(persisted).not.toContain('Show pit tools');
      expect(persisted).not.toContain(session.capability);
    });
  });

  it('isolates capabilities, rejects URL transport and exposes no generic SDK surface', async () => {
    const a = await create();
    const b = await create();
    expect((await start({ ...a, capability: b.capability })).status).toBe(401);
    expect(
      (await cancel({ ...a, capability: b.capability }, crypto.randomUUID()))
        .status,
    ).toBe(401);
    expect(
      (
        await app.request(
          `/agent/sessions/${a.sessionId}/runs?capability=${a.capability}`,
          { method: 'POST' },
          testEnv(),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          `/agents/shopping-agent/${a.sessionId}`,
          { method: 'POST' },
          testEnv(),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/agent/sessions/${a.sessionId}/state`,
          { method: 'POST' },
          testEnv(),
        )
      ).status,
    ).toBe(404);
    expect(
      (await app.request('/agent/sessions', { method: 'POST' }, testEnv()))
        .status,
    ).toBe(503);
  });

  it.each([
    'idle',
    'absolute',
  ])('expires %s sessions and their capabilities', async kind => {
    const session = await create();
    await runInDurableObject(stub(session), (_instance, ctx) => {
      drizzle(ctx.storage)
        .update(visits)
        .set(
          kind === 'idle'
            ? { touched: Date.now() - IDLE_MS }
            : { created: Date.now() - LIFE_MS },
        )
        .run();
    });
    expect((await start(session)).status).toBe(410);
    expect((await cancel(session, crypto.randomUUID())).status).toBe(410);
  });

  it('validates input and handles CORS preflight for the storefront', async () => {
    const session = await create();
    const url = `/agent/sessions/${session.sessionId}/runs`;
    const request = (body: string) =>
      app.request(
        url,
        {
          method: 'POST',
          body,
          headers: { Authorization: `Bearer ${session.capability}` },
        },
        testEnv(),
      );
    expect((await request('{}')).status).toBe(400);
    expect((await request('{')).status).toBe(400);
    expect((await request('x'.repeat(32769))).status).toBe(413);
    const cors = await app.request(
      url,
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://luluspeedworks.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      },
      testEnv(),
    );
    expect(cors.status).toBe(204);
    expect(cors.headers.get('access-control-allow-origin')).toBe(
      'https://luluspeedworks.com',
    );
    expect(cors.headers.get('access-control-allow-headers')).toContain(
      'authorization',
    );
    const blocked = await app.request(
      url,
      { method: 'OPTIONS', headers: { Origin: 'https://untrusted.example' } },
      testEnv(),
    );
    expect(blocked.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('supports cancel-before-start tombstones without inference', async () => {
    const session = await create();
    const runId = crypto.randomUUID();
    const first = await (await cancel(session, runId)).json();
    expect(first).toMatchObject({ runId, reason: 'cancelled' });
    expect(await (await cancel(session, runId)).json()).toEqual(first);
    expect(await (await start(session, runId)).json()).toMatchObject({
      status: 'fallback',
      reason: 'cancelled',
    });
    expect(await calls(session)).toBe(0);
  });

  it('does not duplicate an in-flight run and suppresses cancelled output', async () => {
    const session = await create();
    await mode(session, 'wait');
    const runId = crypto.randomUUID();
    const response = await start(session, runId);
    await vi.waitFor(async () => expect(await calls(session)).toBe(1));
    expect(await (await start(session, runId)).json()).toMatchObject({
      status: 'running',
    });
    await cancel(session, runId);
    const output = await events(response);
    expect(output.some(event => event.name === 'lulu.a2ui.v1')).toBe(false);
    expect(
      output.find(event => event.name === 'lulu.fallback.v1')?.value?.reason,
    ).toBe('cancelled');
    expect(await calls(session)).toBe(1);
  });

  it('supersedes the prior run and retains its originating revision', async () => {
    const session = await create();
    await mode(session, 'wait');
    const older = await start(session, crypto.randomUUID(), 2);
    await vi.waitFor(async () => expect(await calls(session)).toBe(1));
    await mode(session, 'valid');
    const newer = await start(session, crypto.randomUUID(), 3);
    const oldEvents = await events(older);
    expect(
      oldEvents.find(event => event.name === 'lulu.fallback.v1')?.value,
    ).toMatchObject({ reason: 'superseded', uiRevision: 2 });
    expect(
      (await events(newer)).find(event => event.name === 'lulu.a2ui.v1')?.value
        ?.uiRevision,
    ).toBe(3);
  });

  it.each([
    ['disabled', 'disabled'],
    ['malformed', 'invalid_output'],
    ['outage', 'inference_unavailable'],
  ] as const)('returns a typed fallback for %s while commerce remains available', async (value, reason) => {
    const session = await create();
    await mode(session, value);
    const output = await events(await start(session));
    expect(
      output.find(event => event.name === 'lulu.fallback.v1')?.value?.reason,
    ).toBe(reason);
    expect(output.some(event => event.name === 'lulu.a2ui.v1')).toBe(false);
    expect((await app.request('/health', {}, testEnv())).status).toBe(200);
    expect(await calls(session)).toBe(value === 'disabled' ? 0 : 1);
  });

  it('enforces the visitor limit across new sessions', async () => {
    const ip = crypto.randomUUID();
    for (let count = 0; count < 7; count++) {
      const session = await create(ip);
      const output = await events(await start(session));
      if (count === 6) {
        expect(
          output.find(event => event.name === 'lulu.fallback.v1')?.value
            ?.reason,
        ).toBe('rate_limited');
        expect(await calls(session)).toBe(0);
      } else
        expect(output.some(event => event.name === 'lulu.a2ui.v1')).toBe(true);
    }
  });

  it('cancels on disconnect, suppresses output and retains or settles the reservation', async () => {
    const session = await create();
    await mode(session, 'wait');
    const runId = crypto.randomUUID();
    const response = await start(session, runId);
    await vi.waitFor(async () => expect(await calls(session)).toBe(1));
    await response.body?.cancel();
    await vi.waitFor(async () =>
      expect(await (await start(session, runId)).json()).toMatchObject({
        status: 'fallback',
        reason: 'disconnected',
      }),
    );
    const ledger = env.SHOPPING_LEDGER.get(
      env.SHOPPING_LEDGER.idFromName('deployment-account'),
    );
    await runInDurableObject(ledger, (_instance, ctx) => {
      const record = drizzle(ctx.storage)
        .select()
        .from(reservations)
        .all()
        .find(row => row.runId === runId);
      expect(record?.charged).toBeGreaterThan(0);
    });
  });

  it('ends a stalled provider call at the run deadline', async () => {
    const session = await create();
    await mode(session, 'wait');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const response = await start(session);
    if (!response.body) throw new Error('missing stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let stream = '';
    while (!stream.includes('"stage":"inference"')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('inference did not start');
      stream += decoder.decode(chunk.value);
    }
    await runInDurableObject(stub(session), () =>
      vi.advanceTimersByTimeAsync(30_000),
    );
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stream += decoder.decode(chunk.value);
    }
    const output = await events(new Response(stream));
    expect(
      output.find(event => event.name === 'lulu.fallback.v1')?.value?.reason,
    ).toBe('timeout');
    expect(output.some(event => event.name === 'lulu.a2ui.v1')).toBe(false);
  });
});
