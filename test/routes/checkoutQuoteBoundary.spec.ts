import { beforeEach, expect, test, vi } from 'vitest';
import app from '../../src/app';
import {
  createCheckoutQuote,
  readCheckoutQuote,
} from '../../src/modules/checkoutQuotes';
import { mockEnv } from '../mocks/env';

vi.mock('../../src/modules/checkoutQuotes', async importOriginal => ({
  ...(await importOriginal<
    typeof import('../../src/modules/checkoutQuotes')
  >()),
  createCheckoutQuote: vi.fn(async () => ({
    id: 'quote-fixture',
    status: 'valid',
  })),
  readCheckoutQuote: vi.fn(async () => ({
    id: 'quote-fixture',
    status: 'valid',
  })),
}));
const cartId = '11111111-1111-4111-8111-111111111111';
const quoteId = '22222222-2222-4222-8222-222222222222';
const env = mockEnv();
const origin = 'https://luluspeedworks.com';
beforeEach(() => {
  vi.clearAllMocks();
});

/** Exercises quote routes through the real app's browser and identity middleware. */
function request(
  method: string,
  requestedOrigin = origin,
  cookie = 'session=fixture',
) {
  return app.request(
    `/cart/${cartId}/quotes${method === 'GET' ? `/${quoteId}` : ''}`,
    {
      method,
      headers: {
        Origin: requestedOrigin,
        Cookie: cookie,
        'Content-Type': 'application/json',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-cart-token',
      },
      ...(method === 'POST' ? { body: '{}' } : {}),
    },
    env,
  );
}
test('quote preflight preserves credentialed CORS and private caching', async () => {
  const response = await request('OPTIONS');
  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(createCheckoutQuote).not.toHaveBeenCalled();
});
test.each([
  'POST',
  'GET',
])('quote %s preserves session identity through the mounted app', async method => {
  const response = await request(method);
  expect(response.status).toBe(200);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  for (const header of ['Origin', 'Cookie', 'Authorization', 'X-Cart-Token'])
    expect(response.headers.get('Vary')).toContain(header);
  if (method === 'POST')
    expect(createCheckoutQuote).toHaveBeenCalledWith(
      expect.anything(),
      env,
      cartId,
      'user_123',
    );
  else
    expect(readCheckoutQuote).toHaveBeenCalledWith(
      expect.anything(),
      env,
      cartId,
      'user_123',
      quoteId,
    );
});
test.each([
  'POST',
  'GET',
])('quote %s rejects missing sessions before quote operations', async method => {
  const response = await request(method, origin, '');
  expect(response.status).toBe(401);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(createCheckoutQuote).not.toHaveBeenCalled();
  expect(readCheckoutQuote).not.toHaveBeenCalled();
});
test.each([
  'POST',
  'GET',
  'OPTIONS',
])('quote %s rejects hostile origins before quote operations', async method => {
  const response = await request(
    method,
    'https://luluspeedworks.com.evil.example',
  );
  expect(response.status).toBe(403);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(createCheckoutQuote).not.toHaveBeenCalled();
  expect(readCheckoutQuote).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
