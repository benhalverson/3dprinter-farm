import {
  createSecretKey,
  decrypt,
  encrypt,
  type WebSecretKey,
} from 'cipher-kit/web-api';
import type { ProfileData } from '../db/schema';

declare global {
  var __cipherKitSecretKeyCache: Map<string, WebSecretKey> | undefined;
}

const ENCRYPTED_VALUE_REGEX =
  /^([A-Za-z0-9+/_-][A-Za-z0-9+/=_-]*)\.([A-Za-z0-9+/_-][A-Za-z0-9+/=_-]*)\.([A-Za-z0-9+/_-][A-Za-z0-9+/=_-]*)\.$/;

type SecretKeyResult = {
  success: boolean;
  secretKey?: WebSecretKey;
  error?: { message?: string; description?: string };
};

type CipherTextResult = {
  success: boolean;
  result?: string;
  error?: { message?: string; description?: string };
};

function getSecretKeyCache() {
  if (!globalThis.__cipherKitSecretKeyCache) {
    globalThis.__cipherKitSecretKeyCache = new Map<string, WebSecretKey>();
  }

  return globalThis.__cipherKitSecretKeyCache;
}

function unwrapSecretKeyResult(
  value: WebSecretKey | SecretKeyResult,
): WebSecretKey {
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

function unwrapCipherTextResult(
  value: string | CipherTextResult,
  action: 'encrypt' | 'decrypt',
): string {
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
): Promise<WebSecretKey> {
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
  secretKey: WebSecretKey,
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
  secretKey: WebSecretKey,
): Promise<string | null> {
  if (value == null || value === '') {
    return value;
  }

  return unwrapCipherTextResult(await encrypt(value, secretKey), 'encrypt');
}

export async function buildEncryptedProfileUpdate(
  profile: ProfileData,
  secretKey: WebSecretKey,
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

type StoredShippingProfile = Pick<
  ProfileData,
  | 'firstName'
  | 'lastName'
  | 'shippingAddress'
  | 'city'
  | 'state'
  | 'zipCode'
  | 'country'
  | 'phone'
> & {
  email?: string | null;
};

export type DecryptedShippingProfile = {
  email: string;
  firstName: string;
  lastName: string;
  shippingAddress: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  phone: string;
};

export async function decryptStoredShippingProfile(
  profile: StoredShippingProfile,
  passphrase: string,
): Promise<DecryptedShippingProfile> {
  const secretKey = await getCipherKitSecretKey(passphrase);
  const [
    firstName,
    lastName,
    shippingAddress,
    city,
    state,
    zipCode,
    country,
    phone,
  ] = await Promise.all([
    decryptStoredProfileValue(profile.firstName, secretKey),
    decryptStoredProfileValue(profile.lastName, secretKey),
    decryptStoredProfileValue(profile.shippingAddress, secretKey),
    decryptStoredProfileValue(profile.city, secretKey),
    decryptStoredProfileValue(profile.state, secretKey),
    decryptStoredProfileValue(profile.zipCode, secretKey),
    decryptStoredProfileValue(profile.country, secretKey),
    decryptStoredProfileValue(profile.phone, secretKey),
  ]);

  return {
    email: profile.email || '',
    firstName: firstName || '',
    lastName: lastName || '',
    shippingAddress: shippingAddress || '',
    city: city || '',
    state: state || '',
    zipCode: zipCode || '',
    country: country || '',
    phone: phone || '',
  };
}
