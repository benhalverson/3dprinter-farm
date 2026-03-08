import {
  createSecretKey,
  decrypt,
  encrypt,
  type WebApiKey,
} from 'cipher-kit/web-api';
import type { ProfileData } from '../db/schema';

declare global {
  var __cipherKitSecretKeyCache: Map<string, WebApiKey> | undefined;
}

const ENCRYPTED_VALUE_REGEX =
  /^([A-Za-z0-9+/_-][A-Za-z0-9+/=_-]*)\.([A-Za-z0-9+/_-][A-Za-z0-9+/=_-]*)\.([A-Za-z0-9+/_-][A-Za-z0-9+/=_-]*)\.$/;

type SecretKeyResult = {
  success: boolean;
  secretKey?: WebApiKey;
  error?: { message?: string; description?: string };
};

type CipherTextResult = {
  success: boolean;
  result?: string;
  error?: { message?: string; description?: string };
};

function getSecretKeyCache() {
  if (!globalThis.__cipherKitSecretKeyCache) {
    globalThis.__cipherKitSecretKeyCache = new Map<string, WebApiKey>();
  }

  return globalThis.__cipherKitSecretKeyCache;
}

function unwrapSecretKeyResult(value: WebApiKey | SecretKeyResult): WebApiKey {
  if (value && typeof value === 'object' && 'success' in value) {
    if (!value.success || !value.secretKey) {
      throw new Error(
        `cipher-kit key derivation failed: ${value.error?.message || 'Unknown error'} - ${value.error?.description || 'No description'}`,
      );
    }

    return value.secretKey;
  }

  return value;
}

function unwrapCipherTextResult(value: string | CipherTextResult, action: 'encrypt' | 'decrypt'): string {
  if (value && typeof value === 'object' && 'success' in value) {
    if (!value.success || typeof value.result !== 'string') {
      throw new Error(
        `cipher-kit ${action} error: ${value.error?.message || 'Unknown error'} - ${value.error?.description || 'No description'}`,
      );
    }

    return value.result;
  }

  return value;
}

export function isCipherKitEncryptedValue(value: string) {
  return ENCRYPTED_VALUE_REGEX.test(value);
}

export async function getCipherKitSecretKey(
  passphrase: string,
): Promise<WebApiKey> {
  const cache = getSecretKeyCache();
  const cachedKey = cache.get(passphrase);

  if (cachedKey) {
    return cachedKey;
  }

  const secretKey = unwrapSecretKeyResult(await createSecretKey(passphrase));
  cache.set(passphrase, secretKey);
  return secretKey;
}

export async function decryptStoredProfileValue(
  value: string | null,
  secretKey: WebApiKey,
): Promise<string | null> {
  if (value == null || value === '') {
    return value;
  }

  if (!isCipherKitEncryptedValue(value)) {
    return value;
  }

  return unwrapCipherTextResult(await decrypt(value, secretKey), 'decrypt');
}

export async function encryptStoredProfileValue(
  value: string | null,
  secretKey: WebApiKey,
): Promise<string | null> {
  if (value == null || value === '') {
    return value;
  }

  return unwrapCipherTextResult(await encrypt(value, secretKey), 'encrypt');
}

export async function buildEncryptedProfileUpdate(
  profile: ProfileData,
  secretKey: WebApiKey,
) {
  return {
    firstName:
      (await encryptStoredProfileValue(profile.firstName, secretKey)) ?? '',
    lastName:
      (await encryptStoredProfileValue(profile.lastName, secretKey)) ?? '',
    shippingAddress:
      (await encryptStoredProfileValue(profile.shippingAddress, secretKey)) ??
      '',
    city: (await encryptStoredProfileValue(profile.city, secretKey)) ?? '',
    state: (await encryptStoredProfileValue(profile.state, secretKey)) ?? '',
    zipCode:
      (await encryptStoredProfileValue(profile.zipCode, secretKey)) ?? '',
    country:
      (await encryptStoredProfileValue(profile.country, secretKey)) ?? '',
    phone: (await encryptStoredProfileValue(profile.phone, secretKey)) ?? '',
  };
}

type ShippingProfileRow = {
  firstName: string | null;
  lastName: string | null;
  shippingAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  phone: string | null;
};

export type DecryptedShippingProfile = ShippingProfileRow;

/**
 * Decrypts all shipping-related profile fields concurrently using Promise.all.
 * Derives (or reuses a cached) secret key from the given passphrase.
 */
export async function decryptStoredShippingProfile(
  profile: ShippingProfileRow,
  passphrase: string,
): Promise<DecryptedShippingProfile> {
  const secretKey = await getCipherKitSecretKey(passphrase);
  const [firstName, lastName, shippingAddress, city, state, zipCode, phone] =
    await Promise.all([
      decryptStoredProfileValue(profile.firstName, secretKey),
      decryptStoredProfileValue(profile.lastName, secretKey),
      decryptStoredProfileValue(profile.shippingAddress, secretKey),
      decryptStoredProfileValue(profile.city, secretKey),
      decryptStoredProfileValue(profile.state, secretKey),
      decryptStoredProfileValue(profile.zipCode, secretKey),
      decryptStoredProfileValue(profile.phone, secretKey),
    ]);
  return { firstName, lastName, shippingAddress, city, state, zipCode, phone };
}
