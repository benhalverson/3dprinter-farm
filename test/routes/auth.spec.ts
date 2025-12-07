import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src/index';
import { hashPassword, signJWT } from '../../src/utils/crypto';

// Shared dynamic mock for select().from().where()
const mockWhere = vi.fn();

// drizzle-orm mock
vi.mock('drizzle-orm/d1', () => {
  return {
    drizzle: vi.fn(() => ({
      select: () => ({
        from: () => ({ where: mockWhere }),
      }),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([{ id: 1, email: 'mock@test.com' }]),
        }),
      }),
    })),
  };
});

// Mock crypto
vi.mock('../../src/utils/crypto', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    hashPassword: vi.fn(() =>
      Promise.resolve({ salt: 'mock-salt', hash: 'mock-hash' }),
    ),
    verifyPassword: vi.fn(() => Promise.resolve(true)),
    signJWT: vi.fn(() => Promise.resolve('mock.jwt.token')),
  };
});

import { verifyPassword } from '../../src/utils/crypto';

function mockEnv() {
  return {
    JWT_SECRET: 'test-secret',
    RATE_LIMIT_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('Auth Routes', () => {
  const testEmail = 'user@example.com';
  const testPassword = 'securepassword123';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('POST /auth/signup creates a new user', async () => {
    mockWhere.mockResolvedValueOnce([]); // simulate user does not exist

    const request = new Request('http://localhost/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });

    const res = await app.fetch(request, mockEnv());
    expect(res.status).toBe(200);

    const json = (await res.json()) as { message: string };
    expect(json.message).toMatch(/success/i);
    expect(json).toHaveProperty('token');

    expect(hashPassword).toHaveBeenCalledWith(testPassword);
    expect(signJWT).toHaveBeenCalled();

    const setCookieHeader = res.headers.get('set-cookie');
    expect(setCookieHeader).toMatch(/token=mock\.jwt\.token/);
    expect(setCookieHeader).toMatch(/HttpOnly/);
  });

  test('POST /auth/signup returns 409 if user already exists', async () => {
    mockWhere.mockResolvedValueOnce([{ id: 1, email: testEmail }]); // simulate user exists

    const request = new Request('http://localhost/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });

    const res = await app.fetch(request, mockEnv());
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/already exists/i);
  });

  test('POST /auth/signin with existing user and valid password', async () => {
    mockWhere.mockResolvedValueOnce([
      {
        id: 1,
        email: testEmail,
        passwordHash: 'mock-hash',
        passwordSalt: 'mock-salt',
      },
    ]);
    vi.mocked(verifyPassword).mockResolvedValueOnce(true);

    const request = new Request('http://localhost/auth/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });

    const res = await app.fetch(request, mockEnv());
    expect(res.status).toBe(200);

    const json = (await res.json()) as { message: string };
    expect(json.message).toMatch(/success/i);
  });

  test('POST /auth/signin with invalid password returns 401', async () => {
    mockWhere.mockResolvedValueOnce([
      {
        id: 1,
        email: testEmail,
        passwordHash: 'mock-hash',
        passwordSalt: 'mock-salt',
      },
    ]);
    vi.mocked(verifyPassword).mockResolvedValueOnce(false);

    const request = new Request('http://localhost/auth/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: 'wrong-password' }),
    });

    const res = await app.fetch(request, mockEnv());
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/invalid/i);
  });

  test('POST /auth/signin with unknown user returns 401', async () => {
    mockWhere.mockResolvedValueOnce([]); // simulate user not found

    const request = new Request('http://localhost/auth/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'unknown@example.com', password: 'pw' }),
    });

    const res = await app.fetch(request, mockEnv());
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/invalid/i);
  });
});
