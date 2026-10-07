import { z } from 'zod';
import type { SlantStatus } from './slantLifecycle';

export const slantWebhookSchema = z.object({
  event_type: z.string().min(1), platform_id: z.string().min(1),
  event_id: z.string().min(1).max(200).optional(),
  data: z.object({ order: z.object({
    public_id: z.string().min(1).max(200), status: z.string().min(1),
    tracking_number: z.string().max(2048).optional(),
    tracking_url: z.string().max(2048).optional(), carrier: z.string().max(2048).optional(),
    estimated_arrival: z.string().max(2048).optional(),
  }).optional() }),
});
/** Authenticate the exact provider bytes and bounded millisecond delivery timestamp. */
export async function verifySlantWebhook(raw: string, timestamp: string | undefined, signature: string | undefined, secret: string) {
  if (!timestamp || !/^\d{13}$/.test(timestamp) || !signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(signature.slice(7).match(/../g) ?? [], pair => Number.parseInt(pair, 16));
  return crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(`${timestamp}.${raw}`));
}
/** Normalize authenticated facts; exclude delivery timestamps from deduplication. */
export async function normalizeSlantWebhook(body: z.infer<typeof slantWebhookSchema>) {
  if (!body.event_type.startsWith('order.')) return null;
  const order = body.data.order;
  if (!order) throw new Error('Missing order');
  const rawStatus = order.status.toUpperCase();
  const status = ['PAID', 'QUEUED', 'PRINTING', 'AWAITING_SHIPMENT'].includes(rawStatus) ? 'PROCESSING' : rawStatus;
  if (!['DRAFT', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELED'].includes(status)) throw new Error('Unknown order status');
  const metadata = {
    ...(order.tracking_number ? { tracking_number: order.tracking_number } : {}),
    ...(order.tracking_url ? { tracking_url: order.tracking_url } : {}),
    ...(order.carrier ? { carrier: order.carrier } : {}),
    ...(order.estimated_arrival ? { estimated_arrival: order.estimated_arrival } : {}),
  };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
    body.platform_id, body.event_type, order.public_id, status, metadata,
  ])));
  const eventId = body.event_id ?? `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  return { eventId, orderId: order.public_id, status: status as SlantStatus, metadata };
}
