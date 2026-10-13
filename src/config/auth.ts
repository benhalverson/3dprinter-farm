import type { AuthBindings } from '../../lib/auth';

function getAuthSecret(env?: AuthBindings) {
  const secret = env?.BETTER_AUTH_SECRET?.trim();

  if (!secret) {
    throw new Error('BETTER_AUTH_SECRET is required');
  }

  if (secret.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must be at least 32 characters long');
  }

  return secret;
}

function getCookieAttributes(baseURL: string) {
  const isSecure = new URL(baseURL).protocol === 'https:';

  return {
    sameSite: isSecure ? ('none' as const) : ('lax' as const),
    secure: isSecure,
  };
}

function isLocalHost(hostname: string) {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  );
}

function getPasskeyRpId(baseURL: string, env?: AuthBindings) {
  const configuredRpId = env?.RP_ID?.trim();

  if (configuredRpId) {
    return configuredRpId;
  }

  const baseHost = new URL(baseURL).hostname;

  if (isLocalHost(baseHost)) {
    return 'localhost';
  }

  throw new Error('RP_ID is required for non-local environments');
}

function validatePasskeyOrigin(rpID: string, passkeyOrigin?: string) {
  if (!passkeyOrigin) {
    return;
  }

  const originHost = new URL(passkeyOrigin).hostname;
  const isValidRpRelation =
    originHost === rpID || originHost.endsWith(`.${rpID}`);

  if (!isValidRpRelation) {
    throw new Error(
      `PASSKEY_ORIGIN host (${originHost}) must equal RP_ID (${rpID}) or be its subdomain`,
    );
  }
}

/** Pure validation shared by auth initialization and readiness. */
export function authConfiguration(env?: AuthBindings) {
  const baseURL = env?.AUTH_BASE_URL?.trim() || 'http://localhost:8787';
  let url: URL;
  try { url = new URL(baseURL); } catch { throw new Error('AUTH_BASE_URL must be a valid URL'); }
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))))
    throw new Error('AUTH_BASE_URL must use HTTPS outside localhost');
  const rpID = getPasskeyRpId(baseURL, env);
  const passkeyOrigin = env?.PASSKEY_ORIGIN?.trim();
  validatePasskeyOrigin(rpID, passkeyOrigin);
  return { baseURL, rpID, passkeyOrigin, secret: getAuthSecret(env), cookieAttributes: getCookieAttributes(baseURL) };
}
