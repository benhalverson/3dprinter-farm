import { Agent } from 'agents';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { catalogReader } from './catalog';
import { PRICE } from './pricing';
import { SessionHandler } from './session';
import type { Run, Visit } from './storage/contracts';
import migrations from './storage/migrations';
import { runs, visits } from './storage/visit-schema';

export type ShoppingEnv = Cloudflare.Env & { AGENT_NETWORK_SECRET?: string };

/** Production lifecycle and Drizzle persistence for a named shopping visit. */
export class ShoppingAgent extends Agent<ShoppingEnv> {
  private readonly handler: SessionHandler;

  constructor(ctx: DurableObjectState, env: ShoppingEnv) {
    super(ctx, env);
    const db = drizzle(ctx.storage);
    ctx.blockConcurrencyWhile(() => migrate(db, migrations));
    this.handler = new SessionHandler(
      {
        getVisit() {
          return db.select().from(visits).get();
        },
        insertVisit(visit: Visit) {
          db.insert(visits).values(visit).run();
        },
        updateVisit(id: string, changes: Partial<Visit>) {
          db.update(visits).set(changes).where(eq(visits.id, id)).run();
        },
        getRun(id: string) {
          return db.select().from(runs).where(eq(runs.id, id)).get();
        },
        insertRun(run: Run, ignoreConflict = false) {
          const insert = db.insert(runs).values(run);
          if (ignoreConflict) insert.onConflictDoNothing().run();
          else insert.run();
        },
        updateRun(id: string, changes: Partial<Run>) {
          db.update(runs).set(changes).where(eq(runs.id, id)).run();
        },
        interruptRuns() {
          db.update(runs)
            .set({ status: 'fallback', reason: 'interrupted' })
            .where(eq(runs.status, 'running'))
            .run();
        },
      },
      {
        enabled: () => String(env.AGENT_ENABLED) === 'true',
        priceVersion: env.AGENT_PRICE_VERSION,
        ledger: () =>
          env.SHOPPING_LEDGER?.get(
            env.SHOPPING_LEDGER.idFromName('deployment-account'),
          ),
        read: query => catalogReader(env.DB)(query),
        infer: env.AI
          ? (payload, signal) => env.AI.run(PRICE.model, payload, { signal })
          : undefined,
        waitUntil: task => ctx.waitUntil(task),
      },
    );
  }

  onStart() {
    this.handler.onStart();
  }

  onRequest(request: Request) {
    return this.handler.onRequest(request);
  }
}
