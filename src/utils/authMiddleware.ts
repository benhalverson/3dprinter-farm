import { getSignedCookie } from 'hono/cookie';
import { verify } from 'hono/jwt';
import factory from '../factory';

export const authMiddleware = factory.createMiddleware(async (c, next) => {
  const signedToken = await getSignedCookie(c, c.env.JWT_SECRET, 'token');

  if (!signedToken) {
    return c.json({ error: 'Unauthorized (no token)' }, 401);
  }

  try {
    const payload = await verify(signedToken, c.env.JWT_SECRET, {
			 alg: 'HS256',
		});
    c.set('jwtPayload', payload);
    // Standardize `userId` in context for downstream routes
    const payloadObj = payload as unknown as {
      id?: string | number;
      sub?: string | number;
    };
    const id = payloadObj.id ?? payloadObj.sub;
    if (id) {
      c.set('userId', String(id));
    }
    console.log('Verified JWT payload:', payload);
    return next();
  } catch (err) {
    console.error('JWT verification error:', err);
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});
