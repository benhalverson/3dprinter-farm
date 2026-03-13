import { createAuth } from '../../lib/auth';
import factory from '../factory';
import {
  SHARED_ORGANIZATION_ID,
} from '../constants';
import {
  ensureSharedOrganizationMembership,
  mapLegacyRoleToOrganizationRole,
  normalizeLegacyRole,
} from './organization';

type AuthPayload = {
  id?: string;
  email?: string;
  name?: string | null;
  role?: string | null;
};

const CATALOG_MUTATION_ROLES = new Set(['admin', 'owner']);

export const authMiddleware = factory.createMiddleware(async (c, next) => {
  try {
    const auth = createAuth(c.env.DB, c.env);
    const authSession = await auth.api.getSession({
      headers: c.req.raw.headers,
    });

    if (!authSession?.user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const payload = {
      id: String(authSession.user.id),
      email: authSession.user.email,
      name: authSession.user.name,
      role:
        'role' in authSession.user && typeof authSession.user.role === 'string'
          ? authSession.user.role
          : 'user',
    };

    c.set('session', authSession.session);
    c.set('user', authSession.user);
    c.set('jwtPayload', payload);
    c.set('userId', payload.id);

    return next();
  } catch (err) {
    console.error('Auth session verification error:', err);
    return c.json({ error: 'Invalid or expired session' }, 401);
  }
});

export const requireCatalogMutationRole = factory.createMiddleware(
  async (c, next) => {
    const payload = c.get('jwtPayload') as AuthPayload | undefined;

    if (!payload?.id) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const organizationMember = await ensureSharedOrganizationMembership(c.var.db, {
      userId: payload.id,
      role: mapLegacyRoleToOrganizationRole(payload.role),
    });
    const organizationRole = organizationMember.role;

    c.set('organizationId', SHARED_ORGANIZATION_ID);
    c.set('organizationMember', organizationMember ?? null);
    c.set('organizationRole', organizationRole);

    if (!organizationRole) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (!CATALOG_MUTATION_ROLES.has(normalizeLegacyRole(organizationRole))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    return next();
  },
);
