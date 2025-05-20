import type {
	AuthenticationResponseJSON,
	RegistrationResponseJSON,
} from '@simplewebauthn/types';
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { setSignedCookie } from 'hono/cookie';
import { authMiddleware } from '../utils/authMiddleware';
import { authenticators, users, webauthnChallenges } from '../db/schema';
import { base64url, base64urlToUint8Array, signJWT } from '../utils/crypto';
import factory from '../factory';

const passKeyAuth = factory
	.createApp()
	.get('/webauthn/authenticators', authMiddleware, async (c) => {
		const user = c.get('jwtPayload') as { id: number };
		const db = c.var.db;

		const authenticatorsList = await db
			.select()
			.from(authenticators)
			.where(eq(authenticators.userId, user.id));

		return c.json(authenticatorsList);
	})
	.delete('/webauthn/authenticators/:id', authMiddleware, async (c) => {
		const user = c.get('jwtPayload') as { id: number };
		const credentialId = c.req.param('id');
		const db = c.var.db;

		await db
			.delete(authenticators)
			.where(eq(authenticators.credentialId, credentialId));
		// optionally: .where(and(eq(userId, user.id), eq(credentialId, ...)))

		return c.json({ success: true });
	})
	.post('/webauthn/register/begin', authMiddleware, async (c) => {
		const db = c.var.db;
		const user = c.get('jwtPayload') as { id: number; email: string };

		const [existingUser] = await db
			.select()
			.from(users)
			.where(eq(users.id, user.id));

		if (!existingUser) return c.json({ error: 'User not found' }, 404);

		await db
			.select()
			.from(authenticators)
			.where(eq(authenticators.userId, user.id));

		let options;
		try {
			options = await generateRegistrationOptions({
				rpName: c.env.RP_NAME,
				rpID: c.env.RP_ID,
				userID: new TextEncoder().encode(user.id.toString()),
				userName: existingUser.email,
				authenticatorSelection: {
					userVerification: 'preferred',
				},
			});
			console.log('Registration options:', options);
		} catch (error) {
			return c.json(
				{ error: 'Failed to generate options', details: error },
				500
			);
		}
		try {
			if (!options) return;
			await db
				.insert(webauthnChallenges)
				.values({ userId: user.id, challenge: (await options).challenge })
				.onConflictDoUpdate({
					target: [webauthnChallenges.userId],
					set: { challenge: (await options).challenge },
				});
		} catch (error) {
			return c.json({ error: 'Failed', details: error }, 500);
		}
		return c.json(options);
	})
	.post('/webauthn/auth/begin', async (c) => {
		const db = drizzle(c.env.DB);
		const { email } = await c.req.json();
		console.log('Email:', email);

		const [user] = await db.select().from(users).where(eq(users.email, email));
		if (!user) return c.json({ error: 'User not found' }, 404);

		const authenticatorsList = await db
			.select()
			.from(authenticators)
			.where(eq(authenticators.userId, user.id));

		if (!authenticatorsList.length) {
			return c.json({ error: 'No authenticators found' }, 404);
		}

		const options = await generateAuthenticationOptions({
			rpID: c.env.RP_ID,
			userVerification: 'preferred',
			// allowCredentials: authenticatorsList.map((auth) => ({
			// 	id: auth.credentialId,
			// 	type: 'public-key' as const,
			// })),
		});

		await db
			.insert(webauthnChallenges)
			.values({ userId: user.id, challenge: (await options).challenge })
			.onConflictDoUpdate({
				target: [webauthnChallenges.userId],
				set: { challenge: (await options).challenge },
			});

		return c.json({ options, userId: user.id });
	})
	.post('/webauthn/register/finish', authMiddleware, async (c) => {
		const db = c.var.db;
		const user = c.get('jwtPayload') as { id: number; email: string };
		if (!user?.id) return c.json({ error: 'Unauthorized' }, 401);

		let body: any;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Invalid JSON body' }, 400);
		}

		const { id, rawId, response: webauthnResponse } = body;

		if (
			!id ||
			!rawId ||
			!webauthnResponse?.clientDataJSON ||
			!webauthnResponse?.attestationObject
		) {
			return c.json({ error: 'Missing credential fields' }, 400);
		}

		// Get stored challenge for this user
		const [challengeRow] = await db
			.select()
			.from(webauthnChallenges)
			.where(eq(webauthnChallenges.userId, user.id));

		if (!challengeRow) {
			return c.json({ error: 'Missing challenge' }, 400);
		}

		const parsedCredential: RegistrationResponseJSON = {
			id: base64url(base64urlToUint8Array(id)), // Ensure it's Base64URL-encoded
			rawId: base64url(base64urlToUint8Array(rawId)), // Ensure it's Base64URL-encoded
			type: 'public-key',
			response: {
				clientDataJSON: webauthnResponse.clientDataJSON, //base64urlToUint8Array(webauthnResponse.clientDataJSON),
				attestationObject: webauthnResponse.attestationObject,
			},
			clientExtensionResults: {},
		};

		let verification;
		try {
			verification = await verifyRegistrationResponse({
				response: parsedCredential,
				expectedChallenge: challengeRow.challenge,
				// expectedOrigin: 'https://rc-store.benhalverson.dev', // c.env.DOMAIN,
				expectedOrigin: c.env.DOMAIN,
				// expectedRPID: 'rc-store.benhalverson.dev', // c.env.RP_ID,
				requireUserVerification: false,
			})
		} catch (err) {
			return c.json({ error: 'Verification failed', details: err }, 500);
		}

		if (!verification.verified) {
			return c.json({ error: 'Verification failed' }, 400);
		}

		const {
			credential: { id: credentialID, publicKey: credentialPublicKey },
		} = verification.registrationInfo!;

		await db.insert(authenticators).values({
			userId: user.id,
			credentialId: verification.registrationInfo?.credential?.id,
			credentialPublicKey,
			counter: verification.registrationInfo?.credential.counter,
		});

		return c.json({ success: true });
	})
	.post('/webauthn/auth/finish', async (c) => {
		const db = c.var.db;
		const body = await c.req.json();
		console.log('Received body:', body);

		const { email, response } = body;
		if (!email ) {
			return c.json({ error: 'Missing input' }, 400);
		}

		// const [emailId] = await db.select(schema).from(users).where(eq(users.email, email));
		const [userData] = await c.var.db
				.select()
				.from(users)
				.where(eq(email, email));

			console.log('User data:', userData);





		// Retrieve stored challenge for this user
		const [challengeRow] = await db
			.select()
			.from(webauthnChallenges)
			.where(eq(webauthnChallenges.userId, userData.id));


	// first lookup by email
	// then lookup by userid
	// then get the challlenge

		if (!challengeRow) {
			return c.json({ error: 'No challenge found' }, 400);
		}
		const expectedChallenge = challengeRow.challenge;

		// Get the authenticator for this user
		const [authenticator] = await db
			.select()
			.from(authenticators)
			.where(eq(authenticators.userId, userData.id))
			.limit(1);

		if (!authenticator) {
			return c.json({ error: 'No authenticators found' }, 400);
		}

		 // Pass the credential fields as base64url strings (not Uint8Array) as required by @simplewebauthn/server
		const parsedCredential: AuthenticationResponseJSON = {
			id: response.id,
			rawId: response.rawId,
			type: response.type,
			response: {
				clientDataJSON: response.response.clientDataJSON,
				authenticatorData: response.response.authenticatorData,
				signature: response.response.signature,
				userHandle: response.response.userHandle ?? undefined,
			},
			clientExtensionResults: {},
		};

		let verification;
		try {
			verification = await verifyAuthenticationResponse({
				response: parsedCredential,
				expectedChallenge,
				expectedOrigin: c.env.DOMAIN,
				expectedRPID: c.env.RP_ID,
				credential: {
					id: authenticator.credentialId,
					publicKey: authenticator.credentialPublicKey,
					counter: authenticator.counter,
				},
			});
		} catch (err) {
			console.error('Auth verification failed:', err);
			return c.json({ error: 'Verification failed' }, 401);
		}

		if (!verification.verified) {
			return c.json({ error: 'Verification failed' }, 401);
		}

		// Update counter to prevent replay attacks
		await db
			.update(authenticators)
			.set({ counter: verification.authenticationInfo.newCounter })
			.where(eq(authenticators.credentialId, authenticator.credentialId));

		// Issue session token
		const iat = Math.floor(Date.now() / 1000);
		const exp = iat + 60 * 60 * 24; // 1 day

		const token = await signJWT({
			payload: { id: userData.id},
			secret: c.env.JWT_SECRET,
			iat,
			exp,
		});

		await setSignedCookie(c, 'token', token, c.env.JWT_SECRET, {
			httpOnly: true,
			sameSite: 'None',
			path: '/',
			secure: true,
			maxAge: 60 * 60 * 24,
		});

		return c.json({ success: true });
	});

export default passKeyAuth;
