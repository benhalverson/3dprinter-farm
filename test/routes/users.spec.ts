import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src';
import { mockAuth } from '../mocks/auth';
import { mockDrizzle, mockUpdate, mockWhere } from '../mocks/drizzle';
import { mockEnv } from '../mocks/env';
import { mockGlobalFetch } from '../mocks/fetch';

// Mock crypto functions
vi.mock('../../src/utils/crypto', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/crypto')>(
    '../../src/utils/crypto',
  );
  return {
    ...actual,
    decryptField: vi.fn().mockImplementation(async (encryptedData: string) => {
      // Return mock decrypted data based on the field
      if (encryptedData === 'encrypted-test') return 'Test';
      if (encryptedData === 'encrypted-user') return 'User';
      if (encryptedData === 'encrypted-123-main-st') return '123 Main St';
      if (encryptedData === 'encrypted-testville') return 'Testville';
      if (encryptedData === 'encrypted-ts') return 'TS';
      if (encryptedData === 'encrypted-12345') return '12345';
      if (encryptedData === 'encrypted-usa') return 'USA';
      if (encryptedData === 'encrypted-123-456-7890') return '123-456-7890';
      return 'decrypted-value';
    }),
    encryptField: vi.fn().mockImplementation(async (plaintext: string) => {
      return `encrypted-${plaintext.toLowerCase().replace(/\s+/g, '-')}`;
    }),
  };
});

mockAuth();
mockDrizzle();
mockGlobalFetch();

const env = mockEnv();

describe('Profile Endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockWhere
      .mockResolvedValueOnce([
        {
          id: 'user_123',
          email: 'test@example.com',
          firstName: 'encrypted-test',
          lastName: 'encrypted-user',
          shippingAddress: 'encrypted-123-main-st',
          city: 'encrypted-testville',
          state: 'encrypted-ts',
          zipCode: 'encrypted-12345',
          country: 'encrypted-usa',
          phone: 'encrypted-123-456-7890',
        },
      ]);

    // Mock the update for the profile update endpoint
    const updatedUser = {
      id: 'user_123',
      email: 'test2@test.com',
      firstName: 'Test',
      lastName: 'User',
      shippingAddress: '123 Main St',
      city: 'Testville',
      state: 'TS',
      zipCode: '12345',
      country: 'USA',
      phone: '123-456-7890',
    };
    mockUpdate.mockResolvedValueOnce([updatedUser]);
  });

  test('GET /profile', async () => {
    const res = await app.fetch(
      new Request('http://localhost/profile', {
        method: 'GET',
        headers: {
          Cookie: 'better-auth.session_token=mock-session-token',
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
  });

  test('POST /profile/:id updates profile email', async () => {
    const profileData = {
      firstName: 'Test',
      lastName: 'User',
      shippingAddress: '123 Main St',
      city: 'Testville',
      state: 'TS',
      zipCode: '12345',
      country: 'USA',
      phone: '123-456-7890',
      email: 'test2@test.com',
    };
    const res = await app.fetch(
      new Request('http://localhost/profile/user_123', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'better-auth.session_token=mock-session-token',
        },
        body: JSON.stringify(profileData),
      }),
      env,
    );

    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json).toMatchObject({
      email: 'test2@test.com',
    });
  });

  test('POST /profile updates profile with shared encryption flow', async () => {
    mockUpdate.mockResolvedValueOnce([
      {
        id: 'user_123',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        shippingAddress: '123 Main St',
        city: 'Testville',
        state: 'TS',
        zipCode: '12345',
        country: 'USA',
        phone: '123-456-7890',
      },
    ]);

    const profileData = {
      firstName: 'Test',
      lastName: 'User',
      shippingAddress: '123 Main St',
      city: 'Testville',
      state: 'TS',
      zipCode: '12345',
      country: 'USA',
      phone: '123-456-7890',
    };

    const res = await app.fetch(
      new Request('http://localhost/profile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'better-auth.session_token=mock-session-token',
        },
        body: JSON.stringify(profileData),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      email: 'test2@test.com',
      firstName: 'Test',
      shippingAddress: '123 Main St',
    });
  });
});
