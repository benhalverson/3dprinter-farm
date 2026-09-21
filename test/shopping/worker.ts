// Test-only entrypoint. No fixture or inference controls are exported by production.
import { ShoppingAgent as ProductionAgent } from '../../src/shopping/agent';
import type { CatalogQuery } from '../../src/shopping/catalog';
import type { InferenceRequest } from '../../src/shopping/inference';
import { catalog, completion } from './fixtures';

export { default } from '../../src/index';
export { ShoppingLedger } from '../../src/shopping/ledger';

export class ShoppingAgent extends ProductionAgent {
  mode: 'valid' | 'disabled' | 'malformed' | 'outage' | 'wait' = 'valid';
  invocations = 0;
  release?: () => void;
  protected enabled() {
    return this.mode !== 'disabled';
  }
  protected async readCatalog(_query: CatalogQuery) {
    return catalog;
  }
  protected async infer(_payload: InferenceRequest, signal: AbortSignal) {
    this.invocations++;
    if (this.mode === 'outage') throw new Error('mock provider unavailable');
    if (this.mode === 'wait')
      await new Promise<void>(resolve => {
        this.release = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    return completion(this.mode === 'malformed' ? '{' : undefined);
  }
}
