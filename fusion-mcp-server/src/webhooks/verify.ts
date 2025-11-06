/**
 * Webhook signature verification for Autodesk Platform Services (APS)
 * Ensures webhook requests are authentic
 */

interface Env {
  APS_WEBHOOK_SECRET?: string;
  APS_TRUSTED_TENANTS?: string;
}

/**
 * Verify webhook signature using HMAC (Web Crypto API for Cloudflare Workers)
 */
export async function verifyWebhookSignature(
  env: Env,
  payload: string,
  signature: string
): Promise<boolean> {
  try {
    const webhookSecret = env.APS_WEBHOOK_SECRET;
    
    if (!webhookSecret) {
      console.warn('No webhook secret configured');
      return false;
    }

    // Create HMAC hash using Web Crypto API
    const encoder = new TextEncoder();
    const keyData = encoder.encode(webhookSecret);
    const messageData = encoder.encode(payload);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Compare signatures (constant-time comparison to prevent timing attacks)
    return timingSafeEqual(signature, expectedSignature);
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Timing-safe string comparison to prevent timing attacks
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

/**
 * Validate webhook payload structure
 */
export function validateWebhookPayload(payload: any): boolean {
  // Check required fields
  if (!payload.hook || !payload.hook.hookId || !payload.hook.event) {
    return false;
  }

  // Check payload structure
  if (!payload.payload) {
    return false;
  }

  return true;
}

/**
 * Extract webhook event type from payload
 */
export function getWebhookEventType(payload: any): string | null {
  return payload?.hook?.event || null;
}

/**
 * Check if webhook event is from a trusted source
 */
export function isTrustedSource(env: Env, payload: any): boolean {
  const trustedTenants = env.APS_TRUSTED_TENANTS?.split(',') || [];
  
  if (trustedTenants.length === 0) {
    return true; // No tenant filtering if not configured
  }

  const tenant = payload?.hook?.tenant;
  return trustedTenants.includes(tenant);
}
