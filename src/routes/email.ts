import { zValidator } from '@hono/zod-validator';
import factory from '../factory';
import { leads, leadsSchema } from '../db/schema';
import { eq } from 'drizzle-orm';

const email = factory
	.createApp()
	.post('/email', zValidator('json', leadsSchema), async (c) => {
		try {
			const { name, email } = c.req.valid('json');

			const existing = await c.var.db
				.select()
				.from(leads)
				.where(eq(leads.email, email))
				.get();

			if (existing) {
				return c.json(
					{ status: 'error', message: 'Email is already subscribed.' },
					400
				);
			}

			await c.var.db.insert(leads).values({
				name,
				email,
				status: 'pending',
				createdAt: Date.now(),
			});

			const auth = `${c.env.MAILJET_API_KEY}:${c.env.MAILJET_API_SECRET}`;
			const base64Auth = Buffer.from(auth).toString('base64');
			const listId = c.env.MAILJET_CONTACT_LIST_ID;

			const manageContactRes = await fetch(
				`https://api.mailjet.com/v3/REST/contactslist/${listId}/managecontact`,
				{
					method: 'POST',
					headers: {
						Authorization: `Basic ${base64Auth}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						Email: email,
						Name: name,
						Action: 'addnoforce',
					}),
				}
			);

			if (!manageContactRes.ok) {
				const err = await manageContactRes.json();
				console.error('Mailjet list error:', err);
				return c.json(
					{ status: 'error', message: 'Failed to add to contact list' },
					500
				);
			}

			try {
				 await fetch('https://api.mailjet.com/v3.1/send', {
					method: 'POST',
					headers: {
						Authorization: `Basic ${base64Auth}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						Messages: [
							{
								From: {
									Email: c.env.MAILJET_SENDER_EMAIL,
									Name: c.env.MAILJET_SENDER_NAME,
								},
								To: [
									{
										Email: email,
										Name: name,
									},
								],
								Subject: 'Please Confirm Your Subscription',
								HTMLPart: 'Heyo',
							},
						],
					}),
				});

				return c.json("{ status: 'success', message: 'Email sent successfully' }");
			} catch (error) {
				return c.json({ error: 'Failed to send email', details: error }, 500);
			}
		} catch (error: any) {
			console.error('Unexpected error:', error);
			return c.json({ status: 'error', message: 'Internal Server Error' }, 500);
		}
	})
	.post('/email/confirm', async (c) => {
		try {
			const payload = await c.req.json();
			if (!payload.email || payload.email !== 'subscribe') {
				return c.json({ status: 'error', message: 'Invalid request' }, 400);
			}

			await c.var.db
				.update(leads)
				.set({
					status: 'confirmed',
					confirmedAt: Date.now(),
					updatedAt: Date.now(),
				})
				.where(eq(leads.email, payload.email));
		} catch (error) {
			console.error('Error confirming email:', error);
			return c.json({ status: 'error', message: 'Internal Server Error' }, 500);
		}
	});

export default email;
