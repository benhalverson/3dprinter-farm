import { vi } from 'vitest';

const getSession = vi.fn(async ({ headers }: { headers?: Headers }) => {
  const cookie = headers?.get('cookie') || headers?.get('Cookie');
  const authorization = headers?.get('authorization');

  if (!cookie && !authorization) {
    return null;
  }

  return {
    session: {
      id: 'session_123',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    user: {
      id: 'user_123',
      email: 'test@example.com',
      name: 'Test User',
      role: 'user',
    },
  };
});

const signUpEmail = vi.fn(async ({ body }: { body: Record<string, unknown> }) => ({
  user: {
    id: 'user_123',
    email: body.email,
    name: body.name,
  },
  token: 'mock-session-token',
}));

const addMember = vi.fn(async ({ body }: { body: Record<string, unknown> }) => ({
  id: `member:${String(body.organizationId)}:${String(body.userId)}`,
  organizationId: String(body.organizationId),
  userId: String(body.userId),
  role: String(body.role),
  createdAt: new Date(),
}));

const updateMemberRole = vi.fn(async ({ body }: { body: Record<string, unknown> }) => ({
  id: String(body.memberId),
  organizationId: String(body.organizationId),
  userId: 'user_456',
  role: String(body.role),
  createdAt: new Date(),
  user: {
    id: 'user_456',
    email: 'user456@example.com',
    name: 'User 456',
    image: null,
  },
}));

const handler = vi.fn(async (request: Request) => {
  const url = new URL(request.url);

  if (url.pathname.endsWith('/sign-up/email')) {
    return new Response(
      JSON.stringify({
        token: 'mock-session-token',
        user: {
          id: 'user_123',
          email: 'test@example.com',
          name: 'Test User',
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'better-auth.session_token=mock-session-token; HttpOnly; Path=/; SameSite=None; Secure',
        },
      },
    );
  }

  if (url.pathname.endsWith('/sign-in/email')) {
    return new Response(
      JSON.stringify({
        token: 'mock-session-token',
        user: {
          id: 'user_123',
          email: 'test@example.com',
          name: 'Test User',
          role: 'user',
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'better-auth.session_token=mock-session-token; HttpOnly; Path=/; SameSite=None; Secure',
        },
      },
    );
  }

  if (url.pathname.endsWith('/sign-out')) {
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'better-auth.session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=None; Secure',
      },
    });
  }

  if (url.pathname.includes('/passkey/')) {
    return new Response(JSON.stringify({ success: true, options: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});

export function mockAuth() {
  vi.mock('../../lib/auth', () => ({
    createAuth: vi.fn(() => ({
      api: {
        getSession,
        signUpEmail,
        addMember,
        updateMemberRole,
      },
      handler,
    })),
  }));
}

export const mockBetterAuth = {
  getSession,
  signUpEmail,
  addMember,
  updateMemberRole,
  handler,
};
