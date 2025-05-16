import { zValidator } from '@hono/zod-validator';
import factory from '../factory';
import { leads, leadsSchema } from '../db/schema';
import { eq } from 'drizzle-orm';

const email = factory
	.createApp()
	.post('/email', zValidator('json', leadsSchema), async (c) => {
		try {
			// check if the email is already in the database
			const { email } = c.req.valid('json');
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
		} catch (error) {
			console.error('Error checking email:', error);
			return c.json({ status: 'error', message: 'Internal Server Error' }, 500);
		}

		try {
			const auth = `${c.env.MAILJET_API_KEY}:${c.env.MAILJET_API_SECRET}`;
			const base64Auth = Buffer.from(auth).toString('base64');
			const { name, email } = c.req.valid('json');
			console.log('Received email:', name, email);

			await c.var.db.insert(leads).values({
				name,
				email,
				status: 'pending',
				createdAt: Date.now(),
			});

			const listId = c.env.MAILJET_CONTACT_LIST_ID;
			const response = await fetch(
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
						Properties: {
							name,
						},
					}),
				}
			);

			console.log('Mailjet response:', response.status, response.statusText);

			return c.json(
				{ message: 'Signup Successful. Please check your email' },
				200
			);
		} catch (error) {
			console.error('Error:', error);
			return c.json({ status: 'error', message: 'Internal Server Erro' }, 500);
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
