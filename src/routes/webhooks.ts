import { z } from 'zod';
import Stripe from 'stripe';
import factory from '../factory';

const webhookRoutes = factory.createApp().post(
  '/webhook/stripe',
  async c => {
    try {
      const signature = c.req.header('stripe-signature');
      if (!signature) {
        console.warn('Missing Stripe signature header');
        return c.json({ error: 'Missing signature' }, 400);
      }

      const body = await c.req.text();
      const secret = c.env.STRIPE_WEBHOOK_SECRET;

      if (!secret) {
        console.error('STRIPE_WEBHOOK_SECRET not configured');
        return c.json({ error: 'Webhook secret not configured' }, 500);
      }

      let event: Stripe.Event;
      try {
        // Use the async-compatible verification for Cloudflare Workers
        event = await Stripe.webhooks.constructEventAsync(body, signature, secret);
      } catch (err: any) {
        console.error('Webhook signature verification failed:', err.message);
        return c.json({ error: 'Invalid signature' }, 401);
      }

      console.log(`Received webhook event: ${event.type} [${event.id}]`);

      // Handle checkout.session.completed
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as Stripe.Checkout.Session;
        const cartId = session.metadata?.cartId;

        console.log(`Checkout session completed: ${session.id}, cartId: ${cartId}`);

        if (!cartId) {
          console.warn('No cartId in session metadata');
          return c.json({ success: true }); // Acknowledge but don't process
        }

        // TODO: Update your cart/order in DB
        // - Mark cart as paid
        // - Create an order record
        // - Send confirmation email
        // - Trigger print job, etc.

        console.log(`Processing payment for cart: ${cartId}`);
        // Example: await c.var.db.update(orders).set({ status: 'paid', stripeSessionId: session.id }).where(eq(orders.cartId, cartId))
      }

      // Handle payment_intent.succeeded (for embedded checkout flow)
      if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const cartId = paymentIntent.metadata?.cartId;

        console.log(`Payment intent succeeded: ${paymentIntent.id}, cartId: ${cartId}`);

        if (!cartId) {
          console.warn('No cartId in payment intent metadata');
          return c.json({ success: true });
        }

        // TODO: Same order processing as checkout.session.completed
        // - Mark cart as paid
        // - Create order record
        // - Send confirmation email
        // - Trigger print job

        console.log(`Processing payment for cart: ${cartId}`);
      }

      // Handle charge.succeeded (optional)
      if (event.type === 'charge.succeeded') {
        const charge = event.data.object as Stripe.Charge;
        console.log(`Charge succeeded: ${charge.id}`);
      }

      // Acknowledge receipt (must return 200 quickly)
      return c.json({ success: true });
    } catch (error: any) {
      console.error('Webhook error:', error);
      return c.json({ error: error.message || 'Webhook processing failed' }, 500);
    }
  },
);

export default webhookRoutes;
