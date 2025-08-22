const ITERATIONS = 100_000;
const KEY_LENGTH = 32;
const HASH_ALGORITHM = 'SHA-256';

const encode = (str: string): Uint8Array => {
	return new TextEncoder().encode(str);
};

const decode = (buf: ArrayBuffer): string => {
	return new TextDecoder().decode(buf);
};

const arrayBuffertoBase64 = (arrayBuffer: Uint8Array): string => {
	return btoa(String.fromCharCode(...new Uint8Array(arrayBuffer.buffer)));
};

const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
	const binaryString = Buffer.from(base64, 'base64').toString('binary');
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes.buffer;
};

export const deriveEncryptionKey = async (passphrase: string, salt: Uint8Array): Promise<CryptoKey> => {
	const baseKey = await crypto.subtle.importKey(
		'raw',
		encode(passphrase),
		{ name: 'PBKDF2' },
		false,
		['deriveKey']
	);

	return crypto.subtle.deriveKey(
		{
			name: 'PBKDF2',
			salt,
			iterations: ITERATIONS,
			hash: HASH_ALGORITHM,
		},
		baseKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
};

export const encryptField = async (plaintext: string, passphrase: string): Promise<string> => {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const key = await deriveEncryptionKey(passphrase, salt);
	const encoded = encode(plaintext);

	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		encoded
	);

	return `${arrayBuffertoBase64(salt)}:${arrayBuffertoBase64(iv)}:${arrayBuffertoBase64(new Uint8Array(ciphertext))}`;
};

export const decryptField = async (cipherTextCombined: string, passphrase: string): Promise<string> => {
	const [saltStr, ivStr, cipherStr] = cipherTextCombined.split(':');
	const salt = new Uint8Array(base64ToArrayBuffer(saltStr));
	const iv = new Uint8Array(base64ToArrayBuffer(ivStr));
	const ciphertext = base64ToArrayBuffer(cipherStr);

	const key = await deriveEncryptionKey(passphrase, salt);

	const decrypted = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv },
		key,
		ciphertext
	);

	return decode(decrypted);
};

export const hashPassword = async (password: string): Promise<Salt> => {
	const saltBytes = crypto.getRandomValues(new Uint8Array(16));

	const baseKey = await crypto.subtle.importKey(
		'raw',
		encode(password),
		{ name: 'PBKDF2' },
		false, // not extractable
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
	const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : Buffer.from(input);
	const str = buf.toString('base64');
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

export const base64urlToBuffer = (base64url: string): ArrayBuffer => {
	const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
	const padLength = 4 - (base64.length % 4);
	const padded = base64 + '='.repeat(padLength === 4 ? 0 : padLength);
	const binary = atob(padded);
	const buffer = new ArrayBuffer(binary.length);
	const view = new Uint8Array(buffer);
	for (let i = 0; i < binary.length; i++) {
		view[i] = binary.charCodeAt(i);
	}
	return buffer;
};

export const base64urlToUint8Array = (base64url: string): Uint8Array => {
	const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
	const pad = base64.length % 4;
	const padded = base64 + (pad ? '='.repeat(4 - pad) : '');
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
};

export const bufferToBase64url = (buffer: Uint8Array | Buffer): string => {
	return Buffer.from(buffer)
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
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
