import { zValidator } from '@hono/zod-validator';
import factory from '../factory';
import { leads, leadsSchema } from '../db/schema';

const email = factory
	.createApp()
	.post('/email', zValidator('json', leadsSchema), async (c) => {
		try {
			const auth = `${c.env.MAILJET_API_KEY}:${c.env.MAILJET_API_SECRET}`;
			const base64Auth = Buffer.from(auth).toString('base64');
			const { name, email } = c.req.valid('json');

			await c.var.db.insert(leads).values({
				name,
				email,
				status: 'pending',
				createdAt: Date.now(),
			});

			const listId = c.env.MAILJET_CONTACT_LIST_ID;
			await fetch(
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

			return c.json(
				{ message: 'Signup Successful. Please check your email' },
				200
			);
		} catch (error) {
			console.error('Error:', error);
			return c.json({ status: 'error', message: 'Internal Server Erro' }, 500);
		}
	});

export default email;
