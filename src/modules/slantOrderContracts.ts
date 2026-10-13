import { z } from 'zod';

const text = z.string().min(1);
const address = z.object({
  name: text, line1: text, line2: z.string().optional(), city: text,
  state: text, zip: text, country: z.string().length(2),
});
const draft = z.object({
  customer: z.object({ platformId: text, details: z.object({ email: z.string().email(), address }) }),
  items: z.array(z.object({
    type: z.literal('PRINT'), publicFileServiceId: text, filamentId: text,
    quantity: z.number().int().positive().safe(),
  })).min(1),
  metadata: z.record(z.string()).optional(),
});
/** Shared validated DTO for estimate drafts and immutable paid-order drafts. */
export function slantDraft(input: {
  platformId: string;
  customer: { details: { email: string; address: z.infer<typeof address> } };
  items: Array<{ publicFileServiceId: string; filamentId: string; quantity: number }>;
  metadata?: Record<string, string>;
}) {
  return draft.parse({
    customer: { platformId: input.platformId, details: input.customer.details },
    items: input.items.map(item => ({ type: 'PRINT', publicFileServiceId: item.publicFileServiceId, filamentId: item.filamentId, quantity: item.quantity })),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}
const order = z.object({ publicId: text, status: text, metadata: z.record(z.string()).optional() });
export const slantDraftResponse = z.object({ success: z.literal(true), data: z.object({ order: order.extend({ status: z.literal('DRAFT') }) }) });
export const slantProcessResponse = z.object({ success: z.literal(true), data: z.object({
  publicId: text, status: text, processedAt: text, paymentId: text,
}) });
export const slantGetResponse = z.object({ success: z.literal(true), data: z.object({ order }) });
/** Provider production states are local processing, not additional payment states. */
export function slantLocalStatus(status: string): 'processing' | 'shipped' | 'delivered' | undefined {
  if (['PAID', 'QUEUED', 'PRINTING', 'AWAITING_SHIPMENT', 'PROCESSING'].includes(status)) return 'processing';
  if (status === 'SHIPPED') return 'shipped';
  if (status === 'DELIVERED') return 'delivered';
  return undefined;
}
