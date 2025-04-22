import { Context, Next } from 'hono';
import { getSignedCookie } from 'hono/cookie';
import { verify } from 'hono/jwt';

export const authMiddleware = async (c: Context, next: Next) => {
	const signedToken = await getSignedCookie(c, c.env.JWT_SECRET, 'token');

	if (!signedToken) {
		return c.json({ error: 'Unauthorized (no token)' }, 401);
	}

	try {
		const payload = await verify(signedToken, c.env.JWT_SECRET);
		c.set('jwtPayload', payload);
		return next();
	} catch (err) {
		return c.json({ error: 'Invalid or expired token' }, 401);
	}
};
