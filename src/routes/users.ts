import { eq } from 'drizzle-orm';
import { describeRoute } from 'hono-openapi';
import {
  ProfileDataSchema,
  users,
  type ProfileData,
} from '../db/schema';
import factory from '../factory';
import { authMiddleware } from '../utils/authMiddleware';
import {
  buildEncryptedProfileUpdate,
  decryptStoredProfileValue,
  getCipherKitSecretKey,
} from '../utils/profileCrypto';

async function updateProfileRecord(
  c: Parameters<typeof authMiddleware>[0],
  userId: string,
  profile: ProfileData,
) {
  const passphrase = c.env.ENCRYPTION_PASSPHRASE;

  if (!passphrase) {
    return c.json({ error: 'Encryption passphrase missing' }, 500);
  }

  try {
    const secretKey = await getCipherKitSecretKey(passphrase);
    const encryptedProfile = await buildEncryptedProfileUpdate(
      profile,
      secretKey,
    );

    const [userData] = await c.var.db
      .update(users)
      .set(encryptedProfile)
      .where(eq(users.id, userId))
      .returning();

    if (!userData) {
      return c.json({ error: 'User not found' }, 404);
    }

    return c.json({
      id: userData.id,
      email: userData.email,
      firstName: profile.firstName,
      lastName: profile.lastName,
      shippingAddress: profile.shippingAddress,
      city: profile.city,
      state: profile.state,
      zipCode: profile.zipCode,
      country: profile.country,
      phone: profile.phone,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error updating user data (profile update):', error);

    return c.json(
      { error: 'Internal Server Error', details: message },
      500,
    );
  }
}

const userRouter = factory
  .createApp()

  .get(
    '/profile',
    describeRoute({
      description: 'Get the profile of the authenticated user',
      tags: ['User'],
      responses: {
        200: { description: 'User profile retrieved successfully' },
        401: { description: 'Unauthorized' },
        404: { description: 'User not found' },
      },
    }),
    authMiddleware,
    async c => {
      const user = c.get('jwtPayload') as { id: string; email: string };
      if (!user) return c.json({ error: 'Unauthorized' }, 401);

      try {
        const [userData] = await c.var.db
          .select()
          .from(users)
          .where(eq(users.id, user.id));

        console.log('Fetched user data for ID:', user.id, userData);

        if (!userData) return c.json({ error: 'User not found' }, 404);

        const passphrase = c.env.ENCRYPTION_PASSPHRASE;
        console.log('passphrase:', passphrase ? '***' : '(missing)');
        if (!passphrase)
          return c.json({ error: 'Encryption passphrase missing' }, 500);
        const secretKey = await getCipherKitSecretKey(passphrase);

        console.time('decrypt-profile');
        const decryptedProfile = {
          id: userData.id,
          email: userData.email,
          firstName: await decryptStoredProfileValue(userData.firstName, secretKey),
          lastName: await decryptStoredProfileValue(userData.lastName, secretKey),
          address: await decryptStoredProfileValue(
            userData.shippingAddress,
            secretKey,
          ),
          city: await decryptStoredProfileValue(userData.city, secretKey),
          state: await decryptStoredProfileValue(userData.state, secretKey),
          zipCode: await decryptStoredProfileValue(userData.zipCode, secretKey),
          country: await decryptStoredProfileValue(userData.country, secretKey),
          phone: await decryptStoredProfileValue(userData.phone, secretKey),
        };
        console.log(
          'Decrypted profile for user ID:',
          user.id,
          decryptedProfile,
        );
        console.timeEnd('decrypt-profile');
        return c.json(decryptedProfile);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log('Error fetching user data:', error);
        return c.json(
          { error: 'Internal Server Error', details: message },
          500,
        );
      }
    },
  )
  .post(
    '/profile',
    authMiddleware,
    describeRoute({
      description:
        'Update the profile of the authenticated user (no id param required)',
      tags: ['User'],
      responses: {
        200: { description: 'User profile updated successfully' },
        400: { description: 'Validation failed' },
        404: { description: 'User not found' },
        500: { description: 'Internal Server Error' },
      },
    }),
    async c => {
      const authUser = c.get('jwtPayload') as { id: string; email: string };
      if (!authUser) return c.json({ error: 'Unauthorized' }, 401);

      const body = await c.req.json();
      const validation = ProfileDataSchema.safeParse(body);
      if (!validation.success) {
        return c.json(
          { error: 'Validation failed', details: validation.error.errors },
          400,
        );
      }

      const {
        firstName,
        lastName,
        shippingAddress,
        city,
        state,
        zipCode,
        phone,
        country,
      } = validation.data;

      return updateProfileRecord(c, authUser.id, {
        firstName,
        lastName,
        shippingAddress,
        city,
        state,
        zipCode,
        phone,
        country,
      });
    },
  )

  .post(
    '/profile/:id',
    authMiddleware,
    describeRoute({
      description:
        'Update the profile of a user by ID (must match authenticated user)',
      tags: ['User'],
      responses: {
        200: { description: 'User profile updated successfully' },
        400: { description: 'Validation failed' },
        403: { description: 'Forbidden (ID mismatch)' },
        404: { description: 'User not found' },
        500: { description: 'Internal Server Error' },
      },
    }),
    async c => {
      const authUser = c.get('jwtPayload') as { id: string; email: string };
      const userIdParam = c.req.param('id');
      if (!authUser) return c.json({ error: 'Unauthorized' }, 401);
      if (!userIdParam) {
        return c.json({ error: 'Invalid user id' }, 400);
      }
      if (authUser.id !== userIdParam) {
        return c.json({ error: 'Forbidden: cannot modify another user' }, 403);
      }
      const userId = userIdParam;
      const body = await c.req.json();
      const validation = ProfileDataSchema.safeParse(body);
      if (!validation.success) {
        return c.json(
          { error: 'Validation failed', details: validation.error.errors },
          400,
        );
      }

      const {
        firstName,
        lastName,
        shippingAddress,
        city,
        state,
        zipCode,
        phone,
        country,
      } = validation.data;

      const response = await updateProfileRecord(c, userId, {
        firstName,
        lastName,
        shippingAddress,
        city,
        state,
        zipCode,
        phone,
        country,
      });
      console.log('Updated user data for ID:', userId);
      return response;
    },
  );

export default userRouter;
