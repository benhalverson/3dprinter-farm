import { vi } from 'vitest';

type BetterAuthMocks = {
  getSession: ReturnType<typeof vi.fn>;
  signUpEmail: ReturnType<typeof vi.fn>;
  addMember: ReturnType<typeof vi.fn>;
  updateMemberRole: ReturnType<typeof vi.fn>;
  handler: ReturnType<typeof vi.fn>;
};

type DrizzleMocks = {
  mockWhere: ReturnType<typeof vi.fn>;
  mockAll: ReturnType<typeof vi.fn>;
  mockInsert: ReturnType<typeof vi.fn>;
  mockUpdate: ReturnType<typeof vi.fn>;
  mockDelete: ReturnType<typeof vi.fn>;
  mockQuery: {
    cart: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };
  capturedInserts: unknown[];
};

type TestMocks = {
  betterAuth: BetterAuthMocks;
  drizzle: DrizzleMocks;
};

const testGlobals = globalThis as typeof globalThis & {
  __testMocks?: TestMocks;
};

function createBetterAuthMocks(): BetterAuthMocks {
  const getSession = vi.fn(async ({ headers }: { headers?: Headers } = {}) => {
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

  const signUpEmail = vi.fn(
    async ({ body }: { body: Record<string, unknown> }) => ({
      user: {
        id: 'user_123',
        email: body.email,
        name: body.name,
      },
      token: 'mock-session-token',
    }),
  );

  const addMember = vi.fn(
    async ({ body }: { body: Record<string, unknown> }) => ({
      id: `member:${String(body.organizationId)}:${String(body.userId)}`,
      organizationId: String(body.organizationId),
      userId: String(body.userId),
      role: String(body.role),
      createdAt: new Date(),
    }),
  );

  const updateMemberRole = vi.fn(
    async ({ body }: { body: Record<string, unknown> }) => ({
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
    }),
  );

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
            'set-cookie':
              'better-auth.session_token=mock-session-token; HttpOnly; Path=/; SameSite=None; Secure',
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
            'set-cookie':
              'better-auth.session_token=mock-session-token; HttpOnly; Path=/; SameSite=None; Secure',
          },
        },
      );
    }

    if (url.pathname.endsWith('/sign-out')) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie':
            'better-auth.session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=None; Secure',
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

  return {
    getSession,
    signUpEmail,
    addMember,
    updateMemberRole,
    handler,
  };
}

function createDrizzleMocks(): DrizzleMocks {
  return {
    mockWhere: vi.fn(),
    mockAll: vi.fn(),
    mockInsert: vi.fn(),
    mockUpdate: vi.fn(),
    mockDelete: vi.fn(),
    mockQuery: {
      cart: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
    },
    capturedInserts: [],
  };
}

const mocks =
  testGlobals.__testMocks ??
  (testGlobals.__testMocks = {
    betterAuth: createBetterAuthMocks(),
    drizzle: createDrizzleMocks(),
  });

vi.mock('../lib/auth', () => ({
  createAuth: vi.fn(() => ({
    api: {
      getSession: mocks.betterAuth.getSession,
      signUpEmail: mocks.betterAuth.signUpEmail,
      addMember: mocks.betterAuth.addMember,
      updateMemberRole: mocks.betterAuth.updateMemberRole,
    },
    handler: mocks.betterAuth.handler,
  })),
}));

vi.mock('drizzle-orm/d1', () => {
  const whereResult = {
    all: mocks.drizzle.mockAll,
    get: vi.fn().mockResolvedValue(undefined),
    orderBy: vi.fn(() => ({
      all: mocks.drizzle.mockAll,
    })),
  };

  return {
    drizzle: vi.fn(() => ({
      select: () => ({
        from: () => ({
          where: mocks.drizzle.mockWhere.mockReturnValue(whereResult),
          all: mocks.drizzle.mockAll,
          get: vi.fn().mockResolvedValue(undefined),
          leftJoin: () => ({
            where: mocks.drizzle.mockWhere.mockReturnValue(whereResult),
          }),
          innerJoin: () => ({
            where: mocks.drizzle.mockWhere.mockReturnValue(whereResult),
          }),
        }),
      }),
      insert: () => ({
        values: (payload: unknown) => {
          mocks.drizzle.capturedInserts.push(payload);
          return {
            onConflictDoUpdate: vi.fn().mockResolvedValueOnce(undefined),
            returning: mocks.drizzle.mockInsert,
          };
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: mocks.drizzle.mockUpdate,
          }),
        }),
      }),
      delete: () => ({
        where: () => mocks.drizzle.mockDelete,
      }),
      query: mocks.drizzle.mockQuery,
    })),
  };
});

globalThis.fetch = vi.fn().mockImplementation(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    type: 'basic' as const,
    url: '',
    redirected: false,
    body: null,
    bodyUsed: false,
    headers: new Headers(),
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob([])),
    formData: () => Promise.resolve(new FormData()),
    clone: vi.fn(),
  } as unknown as Response),
);
