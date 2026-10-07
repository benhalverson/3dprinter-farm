import { describe, expect, test, vi } from 'vitest';
import app from '../../src/app';
import { mockEnv } from '../mocks/env';

describe('retired printer routes', () => {
  test.each([
    ['POST', '/slice'], ['GET', '/colors'], ['POST', '/estimate'],
    ['POST', '/add-product'], ['POST', '/v2/upload'],
    ['GET', '/v2/uploads'], ['GET', '/v2/uploads/another-users-file'],
  ])('%s %s is unavailable without provider access', async (method, path) => {
    vi.mocked(fetch).mockClear();
    for (const authenticated of [false, true]) {
      const response = await app.fetch(new Request(`http://localhost${path}`, {
        method,
        headers: authenticated ? { Cookie: 'better-auth.session_token=mock-session-token' } : {},
      }), mockEnv());
      expect(response.status).toBe(404);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
