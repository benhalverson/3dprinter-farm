import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { BROWSER_ORIGINS } from '../src/config/browserOrigins';
import { browserCors, browserOriginGuard, privateResponseCache } from '../src/utils/browserSecurity';

/** Builds a disposable Hono boundary with the production browser middleware. */
function harness() {
  return new Hono().use(privateResponseCache).use(browserOriginGuard).use(browserCors)
    .all('*', c => c.json({ ok: true }, c.req.path === '/profile' ? 401 : 200));
}

describe('browser security boundary', () => {
  test.each(BROWSER_ORIGINS)('allows credentialed cart preflight for %s', async origin => {
    const response = await harness().request('/cart/claim', {
      method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-cart-token' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-cart-token');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  test.each(['https://unrelated.example', 'https://luluspeedworks.com.evil.example', 'http://luluspeedworks.com', 'null'])('rejects unrelated origin %s', async origin => {
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      const response = await harness().request('/auth/signout', { method, headers: { origin } });
      expect(response.status).toBe(403);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
  });

  test.each(['/auth/signin', '/api/auth/get-session', '/profile', '/cart/empty', '/orders'])('isolates private success and error responses at %s', async path => {
    const response = await harness().request(path, { headers: { origin: 'https://luluspeedworks.com' } });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    for (const header of ['Origin', 'Cookie', 'Authorization', 'X-Cart-Token']) expect(response.headers.get('vary')).toContain(header);
  });

  test.each(['Cookie', 'Authorization', 'X-Cart-Token'])('isolates arbitrary responses carrying %s', async header => {
    const response = await harness().request('/other', { headers: { [header]: 'private-value' } });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  test('leaves unauthenticated public caching to the public handler', async () => {
    const response = await harness().request('/products');
    expect(response.headers.get('cache-control')).toBeNull();
  });
});
