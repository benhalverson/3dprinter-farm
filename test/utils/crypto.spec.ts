import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, signJWT } from '../../src/utils/crypto';

describe('Password hashing and vertification', () => {
	const password = 'testPassword';

	it('should return base64 encoded salt and has', async () => {
		const { salt, hash } = await hashPassword(password);
		expect(typeof salt).toBe('string');
		expect(typeof hash).toBe('string');
		expect(salt.length).toBeGreaterThan(10);
		expect(hash.length).toEqual(8);
	});

	it('should return true for a valid password', async () => {
		const { salt, hash } = await hashPassword(password);
		const isValid = await verifyPassword(password, salt, hash);
		expect(isValid).toBe(true);
	});

	it('should return false for an invalid password', async () => {
		const { salt, hash } = await hashPassword(password);
		const isValid = await verifyPassword('wrong-password', salt, hash);
		expect(isValid).toBe(false);
	});
});

describe('JWT signing', () => {
	const secret = 'mySecretKey';
	const payload = {
		userId: 123,
		email: 'test@test.com',
	};

	it('should produce a valid JWT', async () => {
		const iat = Math.floor(Date.now() / 1000);
		const exp = iat + 60 * 60;

		const jwt = await signJWT({
			payload: { ...payload },
			secret,
			iat,
			exp,
		});

		const parts = jwt.split('.');

		const header = JSON.parse(base64urlDecode(parts[0]));
		expect(typeof jwt).toBe('string');
		expect(parts.length).toBe(3);
		expect(header.alg).toBe('HS256');
		expect(header.typ).toBe('JWT');

		const decodedPayload = JSON.parse(base64urlDecode(parts[1]));
		expect(decodedPayload.email).toBe(payload.email);
		expect(decodedPayload.userId).toBe(payload.userId);
		expect(decodedPayload.iat).toBe(iat);
		expect(decodedPayload.exp).toBe(exp);

		const now = Math.floor(Date.now() / 1000);
		expect(decodedPayload.iat).toBeLessThanOrEqual(now);
		expect(decodedPayload.exp).toBeGreaterThanOrEqual(now);
	});
});

describe('JWT signing - negative cases', () => {
	const secret = 'supermySecretKey'
	const validPayload = { email: 'test@test.com' }
	const iat = Math.floor(Date.now() / 1000)
	const exp = iat + 60 * 60

	it('should throw if secret is empty', async () => {
		await expect(() =>
			signJWT({
				payload: validPayload,
				secret: '',
				iat,
				exp,
			})
		).rejects.toThrow()
	})

	it('should throw if payload is missing', async () => {
		await expect(() =>
			signJWT({
				// @ts-expect-error testing invalid payload
				payload: undefined,
				secret,
				iat,
				exp,
			})
		).rejects.toThrow()
	})

	it('should throw if exp is before iat', async () => {
		await expect(() =>
			signJWT({
				payload: validPayload,
				secret,
				iat: iat + 100,
				exp: iat, // earlier than iat
			})
		).rejects.toThrow()
	})

	it('should throw if exp or iat is NaN', async () => {
		await expect(() =>
			signJWT({
				payload: validPayload,
				secret,
				iat: NaN,
				exp: NaN,
			})
		).rejects.toThrow()
	})
})


function base64urlDecode(str: string): string {
	const base64 = str
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
	return atob(base64);
}
