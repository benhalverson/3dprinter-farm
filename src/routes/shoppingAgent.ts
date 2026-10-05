import { getAgentByName } from 'agents';
import { bodyLimit } from 'hono/body-limit';
import { describeRoute } from 'hono-openapi';
import { resolver, validator } from 'hono-openapi/zod';
import { z } from 'zod';
import factory from '../factory';
import {
  digest,
  MAX_BYTES,
  networkKey,
  runSchema,
} from '../shopping/contracts';

const shopping = factory.createApp();
shopping.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  // Capabilities are header-only. No generic SDK routing, upgrades or query transport.
  if (c.req.header('upgrade') || new URL(c.req.url).search)
    return c.json({ error: 'invalid_request' }, 400);
  if (!c.env.SHOPPING_AGENT) return c.json({ error: 'agent_unavailable' }, 503);
  await next();
});
shopping.use(
  '*',
  bodyLimit({
    maxSize: MAX_BYTES,
    onError: c => c.json({ error: 'body_too_large' }, 413),
  }),
);
shopping.post(
  '/sessions',
  describeRoute({
    tags: ['Shopping agent'],
    security: [],
    description:
      'Create an anonymous 30-minute visit capability. See docs/shopping-agent.md.',
    responses: {
      201: {
        description:
          'sessionId, capability, expiresAt, absoluteExpiresAt (UTC epoch milliseconds)',
      },
      503: { description: 'Agent identity configuration unavailable' },
    },
  }),
  async c => {
    const ip = c.req.header('cf-connecting-ip');
    const secret = c.env.AGENT_NETWORK_SECRET;
    if (!ip || !secret || secret.length < 32)
      return c.json({ error: 'identity_unavailable' }, 503);
    const sessionId = crypto.randomUUID();
    const capability = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const agent = await getAgentByName(c.env.SHOPPING_AGENT, sessionId);
    const response = await agent.fetch(
      new Request('https://shopping.internal/initialize', {
        method: 'POST',
        body: JSON.stringify({
          id: sessionId,
          capability: await digest(capability),
          visitor: await networkKey(ip, secret),
        }),
      }),
    );
    if (!response.ok) return c.json({ error: 'agent_unavailable' }, 503);
    const expires = z
      .object({ expiresAt: z.number(), absoluteExpiresAt: z.number() })
      .parse(await response.json());
    return c.json({ sessionId, capability, ...expires }, 201);
  },
);
shopping.post(
  '/sessions/:id/runs',
  describeRoute({
    tags: ['Shopping agent'],
    security: [{ agentCapability: [] }],
    description:
      'Run catalog guidance; AG-UI SSE or JSON status for duplicate run IDs. Body: runId UUID, uiRevision integer, message string, context array. See docs/shopping-agent.md.',
    responses: {
      200: {
        description:
          'AG-UI SSE with lulu.a2ui.v1 or lulu.fallback.v1; duplicate status JSON',
        content: {
          'text/event-stream': { schema: { type: 'string' } },
          'application/json': {
            schema: resolver(
              z.object({
                runId: z.string().uuid(),
                uiRevision: z.number().int(),
                status: z.enum(['running', 'completed', 'fallback']),
                reason: z.string().nullable(),
              }),
            ),
          },
        },
      },
      401: { description: 'Invalid capability' },
      410: { description: 'Expired session' },
      413: { description: 'Request exceeds 32 KiB' },
    },
  }),
  validator('json', runSchema, (result, c) => {
    if (!result.success) return c.json({ error: 'invalid_request' }, 400);
  }),
  async c => {
    if (!z.string().uuid().safeParse(c.req.param('id')).success)
      return c.json({ error: 'invalid_session' }, 400);
    if (!c.req.header('authorization')?.startsWith('Bearer '))
      return c.json({ error: 'unauthorized' }, 401);
    const body = JSON.stringify(c.req.valid('json'));
    const agent = await getAgentByName(c.env.SHOPPING_AGENT, c.req.param('id'));
    return agent.fetch(
      new Request('https://shopping.internal/runs', {
        method: 'POST',
        body,
        headers: { authorization: c.req.header('authorization') ?? '' },
        signal: c.req.raw.signal,
      }),
    );
  },
);
shopping.post(
  '/sessions/:id/runs/:runId/cancel',
  describeRoute({
    tags: ['Shopping agent'],
    security: [{ agentCapability: [] }],
    description:
      'Idempotently cancel an owned run, including a run not yet received.',
    responses: {
      200: { description: 'Known terminal run status' },
      401: { description: 'Invalid capability' },
      410: { description: 'Expired session' },
    },
  }),
  async c => {
    if (
      ![c.req.param('id'), c.req.param('runId')].every(
        id => z.string().uuid().safeParse(id).success,
      )
    )
      return c.json({ error: 'invalid_id' }, 400);
    if (!c.req.header('authorization')?.startsWith('Bearer '))
      return c.json({ error: 'unauthorized' }, 401);
    const agent = await getAgentByName(c.env.SHOPPING_AGENT, c.req.param('id'));
    return agent.fetch(
      new Request(
        `https://shopping.internal/runs/${c.req.param('runId')}/cancel`,
        {
          method: 'POST',
          headers: { authorization: c.req.header('authorization') ?? '' },
        },
      ),
    );
  },
);
export default shopping;
