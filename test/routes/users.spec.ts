import { beforeEach, describe, expect, test, vi } from 'vitest';
import app from '../../src';
import { mockAuth, mockBetterAuth } from '../mocks/auth';
import { mockDrizzle, mockUpdate, mockWhere } from '../mocks/drizzle';
import { mockEnv } from '../mocks/env';
import { mockGlobalFetch } from '../mocks/fetch';

// Mock profile crypto functions
vi.mock('../../src/utils/profileCrypto', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/utils/profileCrypto')
  >('../../src/utils/profileCrypto');
  return {
    ...actual,
    getCipherKitSecretKey: vi.fn().mockResolvedValue('mock-secret-key'),
    decryptStoredProfileValue: vi
      .fn()
      .mockImplementation(async (encryptedData: string | null) => {
        if (encryptedData === 'encrypted-test') return 'Test';
        if (encryptedData === 'encrypted-user') return 'User';
        if (encryptedData === 'encrypted-123-main-st') return '123 Main St';
        if (encryptedData === 'encrypted-testville') return 'Testville';
        if (encryptedData === 'encrypted-ts') return 'TS';
        if (encryptedData === 'encrypted-12345') return '12345';
        if (encryptedData === 'encrypted-usa') return 'USA';
        if (encryptedData === 'encrypted-123-456-7890') return '123-456-7890';
        return encryptedData || 'decrypted-value';
      }),
    buildEncryptedProfileUpdate: vi.fn().mockImplementation(async (profile) => ({
      firstName: `encrypted-${profile.firstName.toLowerCase().replace(/\s+/g, '-')}`,
      lastName: `encrypted-${profile.lastName.toLowerCase().replace(/\s+/g, '-')}`,
      shippingAddress: `encrypted-${profile.shippingAddress.toLowerCase().replace(/\s+/g, '-')}`,
      city: `encrypted-${profile.city.toLowerCase().replace(/\s+/g, '-')}`,
      state: `encrypted-${profile.state.toLowerCase().replace(/\s+/g, '-')}`,
      zipCode: `encrypted-${profile.zipCode.toLowerCase().replace(/\s+/g, '-')}`,
      country: `encrypted-${profile.country.toLowerCase().replace(/\s+/g, '-')}`,
      phone: `encrypted-${profile.phone.toLowerCase().replace(/\s+/g, '-')}`,
    })),
  };
});

mockAuth();
mockDrizzle();
mockGlobalFetch();

const env = mockEnv();

function mockAuthenticatedUser(sessionRole = 'user') {
  mockBetterAuth.getSession.mockResolvedValue({
    session: {
      id: 'session_123',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    user: {
      id: 'user_123',
      email: 'test@example.com',
      name: 'Test User',
      role: sessionRole,
    },
  });
}

function mockSharedOrganizationAccess({
  sessionRole = 'user',
  organizationRole = 'member',
}: {
  sessionRole?: string;
  organizationRole?: 'admin' | 'member' | 'owner';
} = {}) {
  mockAuthenticatedUser(sessionRole);

  mockWhere.mockReturnValueOnce({
    get: vi.fn().mockResolvedValue({
      id: 'org_shared_catalog',
      name: '3D Printer Web API',
      slug: '3dprinter-web-api',
    }),
  });

  mockWhere.mockReturnValueOnce({
    get: vi.fn().mockResolvedValue({
      id: 'member_user_123',
      organizationId: 'org_shared_catalog',
      userId: 'user_123',
      role: organizationRole,
    }),
  });
}

describe('Profile Endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('GET /profile', async () => {
    mockAuthenticatedUser();
    mockWhere.mockResolvedValueOnce([
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
    mockAuthenticatedUser();

    mockUpdate.mockResolvedValueOnce([
      {
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
    mockAuthenticatedUser();
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
      email: 'test@example.com',
      firstName: 'Test',
      shippingAddress: '123 Main St',
    });
  });

  test('POST /users/:id/organization-role creates membership and promotes user to admin', async () => {
    mockSharedOrganizationAccess({
      sessionRole: 'admin',
      organizationRole: 'admin',
    });

    mockWhere.mockResolvedValueOnce([
      {
        id: 'user_456',
        email: 'user456@example.com',
        name: 'User 456',
      },
    ]);

    mockWhere.mockReturnValueOnce({
      get: vi.fn().mockResolvedValue({
        id: 'org_shared_catalog',
        name: '3D Printer Web API',
        slug: '3dprinter-web-api',
      }),
    });

    mockWhere.mockReturnValueOnce({
      get: vi.fn().mockResolvedValue(null),
    });

    mockBetterAuth.addMember.mockResolvedValueOnce({
      id: 'member_org_shared_catalog_user_456',
      organizationId: 'org_shared_catalog',
      userId: 'user_456',
      role: 'member',
      createdAt: new Date(),
    });

    mockBetterAuth.updateMemberRole.mockResolvedValueOnce({
      id: 'member_org_shared_catalog_user_456',
      organizationId: 'org_shared_catalog',
      userId: 'user_456',
      role: 'admin',
      createdAt: new Date(),
      user: {
        id: 'user_456',
        email: 'user456@example.com',
        name: 'User 456',
        image: null,
      },
    });

    const res = await app.fetch(
      new Request('http://localhost/users/user_456/organization-role', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'better-auth.session_token=mock-session-token',
        },
        body: JSON.stringify({ role: 'admin' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(mockBetterAuth.addMember).toHaveBeenCalledOnce();
    expect(mockBetterAuth.updateMemberRole).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          memberId: 'member_org_shared_catalog_user_456',
          organizationId: 'org_shared_catalog',
          role: 'admin',
        }),
      }),
    );

    expect(await res.json()).toMatchObject({
      success: true,
      user: {
        id: 'user_456',
        email: 'user456@example.com',
        name: 'User 456',
      },
      member: {
        id: 'member_org_shared_catalog_user_456',
        role: 'admin',
      },
    });
  });

  test('POST /users/:id/organization-role forbids non-admin users', async () => {
    mockSharedOrganizationAccess({
      sessionRole: 'user',
      organizationRole: 'member',
    });

    const res = await app.fetch(
      new Request('http://localhost/users/user_456/organization-role', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'better-auth.session_token=mock-session-token',
        },
        body: JSON.stringify({ role: 'admin' }),
      }),
      env,
    );

    expect(res.status).toBe(403);
    expect(mockBetterAuth.addMember).not.toHaveBeenCalled();
    expect(mockBetterAuth.updateMemberRole).not.toHaveBeenCalled();
  });

  test('POST /users/:id/organization-role forbids modifying your own role', async () => {
    mockSharedOrganizationAccess({
      sessionRole: 'admin',
      organizationRole: 'admin',
    });

    const res = await app.fetch(
      new Request('http://localhost/users/user_123/organization-role', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'better-auth.session_token=mock-session-token',
        },
        body: JSON.stringify({ role: 'member' }),
      }),
      env,
    );

    expect(res.status).toBe(403);
    expect(mockBetterAuth.addMember).not.toHaveBeenCalled();
    expect(mockBetterAuth.updateMemberRole).not.toHaveBeenCalled();
  });

  test('POST /users/:id/organization-role returns 404 when target user does not exist', async () => {
    mockSharedOrganizationAccess({
      sessionRole: 'admin',
      organizationRole: 'admin',
    });

    mockWhere.mockResolvedValueOnce([]);

    const res = await app.fetch(
      new Request('http://localhost/users/missing-user/organization-role', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'better-auth.session_token=mock-session-token',
        },
        body: JSON.stringify({ role: 'admin' }),
      }),
      env,
    );

    expect(res.status).toBe(404);
    expect(mockBetterAuth.addMember).not.toHaveBeenCalled();
    expect(mockBetterAuth.updateMemberRole).not.toHaveBeenCalled();
  });

  test('POST /users/:id/organization-role validates the requested role', async () => {
    mockSharedOrganizationAccess({
      sessionRole: 'admin',
      organizationRole: 'admin',
    });

    const res = await app.fetch(
      new Request('http://localhost/users/user_456/organization-role', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'better-auth.session_token=mock-session-token',
        },
        body: JSON.stringify({ role: 'owner' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(mockBetterAuth.addMember).not.toHaveBeenCalled();
    expect(mockBetterAuth.updateMemberRole).not.toHaveBeenCalled();
  });
});
