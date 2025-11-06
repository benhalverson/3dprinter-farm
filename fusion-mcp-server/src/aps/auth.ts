/**
 * Authentication module for Autodesk Platform Services (APS)
 */

interface Env {
  APS_CLIENT_ID: string;
  APS_CLIENT_SECRET: string;
  APS_SCOPE?: string;
}

interface ApsCredentials {
  clientId: string;
  clientSecret: string;
  scope?: string;
}

interface AuthToken {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/**
 * Get OAuth2 token from Autodesk Platform Services
 */
export async function getAuthToken(env: Env): Promise<string> {
  const credentials: ApsCredentials = {
    clientId: env.APS_CLIENT_ID,
    clientSecret: env.APS_CLIENT_SECRET,
    scope: env.APS_SCOPE || 'data:read data:write',
  };

  const authUrl = 'https://developer.api.autodesk.com/authentication/v2/token';
  
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    scope: credentials.scope,
  });

  const response = await fetch(authUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Authentication failed: ${error}`);
  }

  const data: AuthToken = await response.json();
  return data.access_token;
}

/**
 * Refresh an existing OAuth2 token
 */
export async function refreshToken(env: Env, refreshToken: string): Promise<string> {
  const credentials: ApsCredentials = {
    clientId: env.APS_CLIENT_ID,
    clientSecret: env.APS_CLIENT_SECRET,
  };

  const authUrl = 'https://developer.api.autodesk.com/authentication/v2/token';
  
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: refreshToken,
  });

  const response = await fetch(authUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }

  const data: AuthToken = await response.json();
  return data.access_token;
}
