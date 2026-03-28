type TestMocks = {
  betterAuth: {
    getSession: any;
    signUpEmail: any;
    addMember: any;
    updateMemberRole: any;
    handler: any;
  };
};

const testGlobals = globalThis as typeof globalThis & {
  __testMocks?: TestMocks;
};

if (!testGlobals.__testMocks) {
  throw new Error('Expected auth mocks to be initialized in test/setup.ts');
}

export function mockAuth() {
  // Mocks are initialized in test/setup.ts before test modules load.
}

export const mockBetterAuth = testGlobals.__testMocks.betterAuth;
