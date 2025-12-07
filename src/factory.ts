import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { createFactory } from "hono/factory";

import * as schema from "./db/schema";

// —————————————————————————————————————————————————————————————————————————————
// Environment

export type WorkerEnv = {
  Bindings: Env;
  Variables: {
    db: DrizzleD1Database<typeof schema>;
  };
};

// —————————————————————————————————————————————————————————————————————————————
// Factory

/**
 * App factory for creating routes with context.
 * @example
 * ```ts
 * const app = factory.createApp()
 * ```
 */
const factory = createFactory<WorkerEnv>({
  initApp(app) {
    app.use(async (c, next) => {
      c.set("db", drizzle(c.env.DB, { schema }));
      await next();
    });
  },
});

export default factory;
