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
  stop: (reason: Fallback, disconnected?: boolean) => void;
};

/** Only coordination metadata is durable. No prompts, history, model text or UI batches. */
export class SessionHandler {
  constructor(
    private readonly storage: SessionStorage,
    private readonly deps: SessionDependencies,
  ) {}
  private live?: LiveRun;
  onStart() {
    this.storage.interruptRuns();
  }

  async onRequest(request: Request): Promise<Response> {
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
      if (this.session()) return new Response(null, { status: 409 });
      const now = Date.now();
      this.storage.insertVisit({ ...init, created: now, touched: now });
      return Response.json({
        expiresAt: now + IDLE_MS,
        absoluteExpiresAt: now + LIFE_MS,
      });
    }
    const supplied =
      request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const hash = await digest(supplied);
    const session = this.session();
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
      this.live?.stop('cancelled');
      return Response.json({ error: 'session_expired' }, { status: 410 });
    }
    this.storage.updateVisit(session.id, { touched: Date.now() });
    const cancel = /^\/runs\/([0-9a-f-]+)\/cancel$/i.exec(path);
    if (cancel && z.string().uuid().safeParse(cancel[1]).success) {
      if (this.live?.id === cancel[1]) this.live.stop('cancelled');
      // Persist a tombstone even for a cancellation which overtakes its run request.
      this.storage.insertRun(
        {
          id: cancel[1],
          revision: 0,
          status: 'fallback',
          reason: 'cancelled',
        },
        true,
      );
      const known = this.run(cancel[1]);
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
    const known = this.run(input.runId);
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
    this.live?.stop('superseded');
    this.storage.insertRun({
      id: input.runId,
      revision: input.uiRevision,
      status: 'running',
      reason: null,
    });

    const encoder = new EventEncoder();
    const utf8 = new TextEncoder();
    const abort = new AbortController();
    let closed = false;
    let invocationCount = 0;
    const started = Date.now();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let timer: ReturnType<typeof setTimeout>;
    const send = (event: Event) => {
      if (!closed) controller.enqueue(utf8.encode(encoder.encodeSSE(event)));
    };
    const custom = (name: string, value: object) =>
      send({
        type: EventType.CUSTOM,
        name,
        value: { runId: input.runId, uiRevision: input.uiRevision, ...value },
      });
    const finish = (reason?: Fallback, disconnected = false) => {
      if (closed) return;
      this.storage.updateRun(input.runId, {
        status: reason ? 'fallback' : 'completed',
        reason: reason ?? null,
      });
      if (!disconnected) {
        if (reason) custom('lulu.fallback.v1', { reason });
        send({
          type: EventType.RUN_FINISHED,
          threadId: session.id,
          runId: input.runId,
          result: {
            uiRevision: input.uiRevision,
            status: reason ? 'fallback' : 'completed',
            reason,
          },
        });
      }
      closed = true;
      clearTimeout(timer);
      request.signal.removeEventListener('abort', disconnectedHandler);
      if (this.live?.id === input.runId) this.live = undefined;
      abort.abort();
      if (!disconnected) controller.close();
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
    const disconnectedHandler = () => finish('disconnected', true);
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      cancel() {
        finish('disconnected', true);
      },
    });
    this.live = { id: input.runId, stop: finish };
    timer = setTimeout(
      () => finish('timeout'),
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
          finish();
        }
      } catch (error) {
        finish(
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
