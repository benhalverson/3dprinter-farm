import { createAuth } from '../../lib/auth';
import factory from '../factory';

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
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});
