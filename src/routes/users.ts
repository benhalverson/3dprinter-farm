import { Hono } from 'hono';
import { Bindings } from '../types';
import { authMiddleware } from '../utils/authMiddleware';
import { drizzle } from 'drizzle-orm/d1';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';

const userRouter = new Hono<{ Bindings: Bindings}>();
userRouter.get('/profile', authMiddleware, async (c) => {
	const user = c.get('jwtPayload') as { id: number; email: string };
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const db = drizzle(c.env.DB);
	try {
		const [userData] = await db
			.select()
			.from(users)
			.where(eq(users.id, user.id));

		if (!userData) {
			return c.json({ error: 'User not found' }, 404);
		}

		return c.json({
			id: userData.id,
			email: userData.email,
			firstName: userData.firstName,
			lastName: userData.lastName,
		});
	} catch (error: any) {
		console.error('Error fetching user data:', error);
		return c.json(
			{ error: 'Internal Server Error', details: error.message },
			500
		);
	}
});

export default userRouter;
