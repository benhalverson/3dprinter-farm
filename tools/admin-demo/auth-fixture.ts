/** Test-only BetterAuth session boundary; production role and organization middleware still executes. */
export function createAuth() {
  return {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        const cookie = headers.get('cookie') ?? '';
        const role = cookie.includes('demo-session=admin')
          ? 'admin'
          : cookie.includes('demo-session=member')
            ? 'member'
            : null;
        if (!role) return null;
        return {
          session: {
            id: `demo-${role}`,
            expiresAt: new Date(Date.now() + 86400000),
          },
          user: {
            id: `demo-${role}`,
            name: `Demo ${role}`,
            email: `${role}@example.test`,
            role,
          },
        };
      },
    },
  };
}
