import type { Mock } from 'vitest';

type SessionRequest = {
  headers?: Headers;
};

type AuthSession = {
  session: {
    id: string;
    expiresAt: Date;
  };
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  };
};

type SignUpEmailRequest = {
  body: {
    email: string;
    name: string;
  } & Record<string, unknown>;
};

type AddMemberRequest = {
  body: {
    organizationId: string;
    userId: string;
    role: string;
  } & Record<string, unknown>;
};

type UpdateMemberRoleRequest = {
  body: {
    memberId: string;
    organizationId: string;
    role: string;
  } & Record<string, unknown>;
};

type SharedDbMock = Mock<(...args: unknown[]) => unknown | Promise<unknown>>;
type AsyncDbMock = Mock<(...args: unknown[]) => Promise<unknown>>;

export type BetterAuthMocks = {
  getSession: Mock<(request?: SessionRequest) => Promise<AuthSession | null>>;
  signUpEmail: Mock<
    (request: SignUpEmailRequest) => Promise<{
      user: {
        id: string;
        email: string;
        name: string;
      };
      token: string;
    }>
  >;
  addMember: Mock<
    (request: AddMemberRequest) => Promise<{
      id: string;
      organizationId: string;
      userId: string;
      role: string;
      createdAt: Date;
    }>
  >;
  updateMemberRole: Mock<
    (request: UpdateMemberRoleRequest) => Promise<{
      id: string;
      organizationId: string;
      userId: string;
      role: string;
      createdAt: Date;
      user: {
        id: string;
        email: string;
        name: string;
        image: null;
      };
    }>
  >;
  handler: Mock<(request: Request) => Promise<Response>>;
};

export type DrizzleMocks = {
  mockWhere: SharedDbMock;
  mockAll: AsyncDbMock;
  mockInsert: AsyncDbMock;
  mockUpdate: AsyncDbMock;
  mockDelete: AsyncDbMock;
  mockQuery: {
    cart: {
      findFirst: AsyncDbMock;
      findMany: AsyncDbMock;
    };
  };
  capturedInserts: unknown[];
};

export type TestMocks = {
  betterAuth: BetterAuthMocks;
  drizzle: DrizzleMocks;
};
