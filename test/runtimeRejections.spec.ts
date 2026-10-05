import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

/** Rejects inside an async operation to exercise Worker promise adoption. */
async function rejectOperation() {
  throw new Error('Expected test failure');
}

/** Returns an adopted promise as ordinary application helpers do. */
async function adoptOperation() {
  return rejectOperation();
}

describe('Worker handled rejections', () => {
  it('catches an adopted async rejection', async () => {
    await expect(adoptOperation()).rejects.toThrow('Expected test failure');
  });

  it('returns a handled route error response', async () => {
    const app = new Hono().onError(() => new Response('Handled', { status: 500 }));
    app.get('/', async () => {
      await adoptOperation();
      return new Response('Unexpected success');
    });
    const response = await app.request('http://localhost/');
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Handled');
  });
});
