import { type Event, EventType } from '@ag-ui/core';
import { EventEncoder } from '@ag-ui/encoder';
import { z } from 'zod';
import type { CatalogItem, CatalogQuery } from './catalog';
import {
  boundedBody,
  digest,
  type Fallback,
  IDLE_MS,
  LIFE_MS,
  RUN_MS,
  type RunInput,
  runSchema,
  ShoppingFailure,
} from './contracts';
import { type Accounting, type Inference, runInference } from './inference';
import { PRICE } from './pricing';
import type { SessionStorage } from './storage/contracts';

export type SessionDependencies = {
  enabled(): boolean;
  priceVersion?: string;
  ledger():
    | (Accounting & {
        admit(
          visitor: string,
          sessionId: string,
          runId: string,
        ): Promise<boolean>;
      })
    | undefined;
  read(query: CatalogQuery): Promise<CatalogItem[]>;
  infer?: Inference;
  waitUntil(task: Promise<void>): void;
};
type LiveRun = {
  id: string;
  stop: (reason: Fallback, disconnected?: boolean) => Promise<void>;
};

/** Only coordination metadata is durable. No prompts, history, model text or UI batches. */
export class SessionHandler {
  constructor(
    private readonly storage: SessionStorage,
    private readonly deps: SessionDependencies,
  ) {}
  private live?: LiveRun;
  onStart() {
    return this.storage.interruptRuns();
  }

  private requests: Promise<unknown> = Promise.resolve();

  onRequest(request: Request): Promise<Response> {
    const response = this.requests
      .then(() => this.handleRequest(request))
      .catch(() =>
        Response.json({ error: 'accounting_unavailable' }, { status: 503 }),
      );
    this.requests = response.catch(() => undefined);
    return response;
  }

  private async handleRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST' || request.headers.has('upgrade'))
      return new Response(null, { status: 404 });
    if (path === '/initialize') {
      const init = z
        .object({
          id: z.string().uuid(),
          capability: z.string().length(64),
          visitor: z.string().length(64),
        })
        .parse(await request.json());
      if (await this.session()) return new Response(null, { status: 409 });
      const now = Date.now();
      if (
        !(await this.storage.insertVisit({
          ...init,
          created: now,
          touched: now,
        }))
      )
        return new Response(null, { status: 409 });
      return Response.json({
        expiresAt: now + IDLE_MS,
        absoluteExpiresAt: now + LIFE_MS,
      });
    }
    const supplied =
      request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const hash = await digest(supplied);
    const session = await this.session();
    if (
      !session ||
      !crypto.subtle.timingSafeEqual(
        new TextEncoder().encode(hash),
        new TextEncoder().encode(session.capability),
      )
    )
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    if (
      Date.now() >=
      Math.min(session.touched + IDLE_MS, session.created + LIFE_MS)
    ) {
      await this.live?.stop('cancelled');
      return Response.json({ error: 'session_expired' }, { status: 410 });
    }
    await this.storage.updateVisit(session.id, { touched: Date.now() });
    const cancel = /^\/runs\/([0-9a-f-]+)\/cancel$/i.exec(path);
    if (cancel && z.string().uuid().safeParse(cancel[1]).success) {
      if (this.live?.id === cancel[1]) await this.live.stop('cancelled');
      // Persist a tombstone even for a cancellation which overtakes its run request.
      await this.storage.insertRun({
        id: cancel[1],
        revision: 0,
        status: 'fallback',
        reason: 'cancelled',
      });
      await this.storage.updateRun(cancel[1], {
        status: 'fallback',
        reason: 'cancelled',
      });
      const known = await this.run(cancel[1]);
      return Response.json({
        runId: known?.id,
        uiRevision: known?.revision,
        status: known?.status,
        reason: known?.reason,
      });
    }
    if (path !== '/runs') return new Response(null, { status: 404 });
    let input: RunInput;
    try {
      input = runSchema.parse(JSON.parse(await boundedBody(request)));
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof RangeError ? 'body_too_large' : 'invalid_request',
        },
        { status: error instanceof RangeError ? 413 : 400 },
      );
    }
    const known = await this.run(input.runId);
    if (known)
      return Response.json({
        runId: known.id,
        uiRevision: known.revision,
        status: known.status,
        reason: known.reason,
      });
    // The body read may have yielded; check expiry again before admission.
    if (
      Date.now() >=
      Math.min(session.created + LIFE_MS, session.touched + IDLE_MS)
    )
      return Response.json({ error: 'session_expired' }, { status: 410 });
    await this.live?.stop('superseded');
    const inserted = await this.storage.insertRun({
      id: input.runId,
      revision: input.uiRevision,
      status: 'running',
      reason: null,
    });

    if (!inserted) {
      const existing = await this.run(input.runId);
      return Response.json({
        runId: existing?.id,
        uiRevision: existing?.revision,
        status: existing?.status,
        reason: existing?.reason,
      });
    }

    const encoder = new EventEncoder();
    const utf8 = new TextEncoder();
    const abort = new AbortController();
    let closed = false;
    let invocationCount = 0;
    const started = Date.now();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let timer: ReturnType<typeof setTimeout>;
    const send = (event: Event, terminal = false) => {
      if (!closed || terminal)
        controller.enqueue(utf8.encode(encoder.encodeSSE(event)));
    };
    const custom = (name: string, value: object, terminal = false) =>
      send(
        {
          type: EventType.CUSTOM,
          name,
          value: { runId: input.runId, uiRevision: input.uiRevision, ...value },
        },
        terminal,
      );
    let completion: Promise<void> | undefined;
    let streamDisconnected = false;
    const finish = (reason?: Fallback, disconnected = false): Promise<void> => {
      streamDisconnected ||= disconnected;
      if (completion) return completion;
      completion = finishRun(reason);
      return completion;
    };
    const finishRun = async (reason?: Fallback) => {
      if (closed) return;
      closed = true;
      abort.abort();
      clearTimeout(timer);
      try {
        await this.storage.updateRun(input.runId, {
          status: reason ? 'fallback' : 'completed',
          reason: reason ?? null,
        });
      } catch {
        // The durable running row still prevents a duplicate invocation and is
        // interrupted on restart. Close this stream even while D1 is unavailable.
        reason = 'accounting_unavailable';
      }
      if (!streamDisconnected) {
        if (reason) custom('lulu.fallback.v1', { reason }, true);
        send(
          {
            type: EventType.RUN_FINISHED,
            threadId: session.id,
            runId: input.runId,
            result: {
              uiRevision: input.uiRevision,
              status: reason ? 'fallback' : 'completed',
              reason,
            },
          },
          true,
        );
      }
      request.signal.removeEventListener('abort', disconnectedHandler);
      if (this.live?.id === input.runId) this.live = undefined;
      if (!streamDisconnected) controller.close();
      console.log(
        JSON.stringify({
          event: 'shopping_run',
          sessionId: session.id,
          runId: input.runId,
          uiRevision: input.uiRevision,
          latencyMs: Date.now() - started,
          invocationCount,
          reason: reason ?? null,
        }),
      );
    };
    const backgroundFinish = (reason: Fallback, disconnected = false) => {
      this.deps.waitUntil(finish(reason, disconnected));
    };
    const disconnectedHandler = () => backgroundFinish('disconnected', true);
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel() {
        return finish('disconnected', true);
      },
    });
    this.live = { id: input.runId, stop: finish };
    timer = setTimeout(
      () => backgroundFinish('timeout'),
      Math.min(RUN_MS, session.created + LIFE_MS - Date.now()),
    );
    request.signal.addEventListener('abort', disconnectedHandler, {
      once: true,
    });
    send({
      type: EventType.RUN_STARTED,
      threadId: session.id,
      runId: input.runId,
      metadata: { uiRevision: input.uiRevision },
    });
    custom('lulu.progress.v1', { stage: 'admission', invocation: 0 });
    const execute = async () => {
      try {
        if (!this.deps.enabled()) throw new ShoppingFailure('disabled');
        const ledger = this.deps.ledger();
        if (!ledger || this.deps.priceVersion !== PRICE.version)
          throw new ShoppingFailure('accounting_unavailable');
        if (!this.deps.infer)
          throw new ShoppingFailure('inference_unavailable');
        let admitted: boolean;
        try {
          admitted = await ledger.admit(
            session.visitor,
            session.id,
            input.runId,
          );
        } catch {
          throw new ShoppingFailure('accounting_unavailable');
        }
        if (!admitted) throw new ShoppingFailure('rate_limited');
        if (closed) return;
        const result = await runInference(input, session.id, {
          read: query => this.deps.read(query),
          accounting: ledger,
          signal: abort.signal,
          active: () => !closed && this.live?.id === input.runId,
          infer: this.deps.infer,
          progress: count => {
            invocationCount = count;
            custom('lulu.progress.v1', {
              stage: 'inference',
              invocation: count,
            });
          },
        });
        if (!closed) {
          custom('lulu.a2ui.v1', result);
          await finish();
        }
      } catch (error) {
        await finish(
          error instanceof ShoppingFailure
            ? error.reason
            : 'inference_unavailable',
        );
      }
    };
    if (request.signal.aborted) disconnectedHandler();
    else this.deps.waitUntil(execute());
    return new Response(body, {
      headers: {
        'Content-Type': encoder.getContentType(),
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  private session() {
    return this.storage.getVisit();
  }
  private run(id: string) {
    return this.storage.getRun(id);
  }
}
