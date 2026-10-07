/** Sign provider-shaped fixture bytes without network/provider access. */
export async function signedSlant(body: unknown, secret: string | null = 'test-secret', timestamp = String(Date.now())) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Webhook-Timestamp': timestamp };
  if (secret) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${raw}`)));
    headers['X-Webhook-Signature-256'] = `sha256=${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  return { method: 'POST', headers, body: raw };
}
/** Translate existing lifecycle fixture facts into provider envelopes. */
export function slantEnvelope(value: unknown) {
  const input = value as { eventId?: string; orderId?: string; status?: string; metadata?: Record<string, unknown> };
  return { event_type: 'order.updated', platform_id: 'test-platform-id', event_id: input.eventId, data: { order: {
    public_id: input.orderId, status: input.status,
    tracking_number: input.metadata?.tracking_number ?? input.metadata?.trackingNumber,
    tracking_url: input.metadata?.tracking_url ?? input.metadata?.trackingUrl,
    carrier: input.metadata?.carrier,
    estimated_arrival: input.metadata?.estimated_arrival ?? input.metadata?.estimatedArrival,
  } } };
}
