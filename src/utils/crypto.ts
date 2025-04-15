const ITERATIONS = 100_000;
const KEY_LENGTH = 32;
const HASH_ALGORITHM = 'SHA-256';

const encode = (str: string): Uint8Array => {
	return new TextEncoder().encode(str);
};

const arrayBuffertoBase64 = (arrayBuffer: Uint8Array): string => {
	return btoa(String.fromCharCode(...new Uint8Array(arrayBuffer.buffer)));
};

const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
	const binaryString = atob(base64);
	const byptes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		byptes[i] = binaryString.charCodeAt(i);
	}
	return byptes.buffer;
};
export const hashPassword = async (password: string): Promise<Salt> => {
	// Generate a random 16-byte salt
	const saltBytes = crypto.getRandomValues(new Uint8Array(16));

	// Import the password as a raw key
	const baseKey = await crypto.subtle.importKey(
		'raw',
		encode(password),
		{ name: 'PBKDF2' },
		false, // not extractable
		['deriveBits']
	);

	// Derive bits with PBKDF2 + salt
	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt: saltBytes,
			iterations: ITERATIONS,
			hash: HASH_ALGORITHM,
		},
		baseKey,
		KEY_LENGTH
	);

	return {
		salt: arrayBuffertoBase64(saltBytes),
		hash: arrayBuffertoBase64(new Uint8Array(derivedBits)),
	};
};

export const verifyPassword = async (
	password: string,
	saltBase64: string,
	hashBase64: string
): Promise<boolean> => {
	const salt = base64ToArrayBuffer(saltBase64);
	const saltBytes = new Uint8Array(salt);

	const baseKey = await crypto.subtle.importKey(
		'raw',
		encode(password),
		{ name: 'PBKDF2' },
		false,
		['deriveBits']
	);

	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt: saltBytes,
			iterations: ITERATIONS,
			hash: HASH_ALGORITHM,
		},
		baseKey,
		KEY_LENGTH
	);
	return arrayBuffertoBase64(new Uint8Array(derivedBits)) === hashBase64;
};

export const base64url = (input: Uint8Array | string): string => {
	const str =
		typeof input === 'string'
			? btoa(input)
			: btoa(String.fromCharCode(...input));
	return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const signJWT = async ({
	payload,
	secret,
	iat,
	exp,
}: Payload): Promise<string> => {
	const encoder = new TextEncoder();
	if (!payload || typeof payload !== 'object') {
		throw new Error('Invalid payload');
	}

	if (!secret || typeof secret !== 'string') {
		throw new Error('Invalid secret');
	}

	if (!Number.isFinite(iat) || !Number.isFinite(exp)) {
		throw new Error('iat and exp must be numbers');
	}

	if (exp <= iat) {
		throw new Error('exp must be greater than iat');
	}

	const header = {
		alg: 'HS256',
		typ: 'JWT',
	};

	const now = Math.floor(Date.now() / 1000);

	payload.iat = iat;
	payload.exp = exp;

	const encodedHeader = base64url(encoder.encode(JSON.stringify(header)));
	const encodedPayload = base64url(encoder.encode(JSON.stringify(payload)));
	const data = `${encodedHeader}.${encodedPayload}`;

	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: { name: 'SHA-256' } },
		false,
		['sign']
	);

	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
	const encodedSignature = base64url(new Uint8Array(signature));

	return `${data}.${encodedSignature}`;
};

interface Payload {
	payload: Record<string, unknown>;
	secret: string;
	iat: number;
	exp: number;
}

interface Salt {
	salt: string;
	hash: string;
}
