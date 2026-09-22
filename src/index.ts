import app from './app';
import { flushBudgetAlerts } from './shopping/budget-alerts';
import { alertStorage } from './shopping/storage/d1';

export type { App } from './app';
export { ShoppingAgent } from './shopping/agent';

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Cloudflare.Env) {
    await flushBudgetAlerts(alertStorage(env.DB), env);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
