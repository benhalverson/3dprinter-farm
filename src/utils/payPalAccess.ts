import type { Context } from "hono";

export const getPayPalAccessToken = async (c: Context) => {
  const auth = Buffer.from(
    `${c.env.PAYPAL_CLIENT_ID}:${c.env.PAYPAL_SECRET}`,
  ).toString("base64");

  const payload = {
    grant_type: "client_credentials",
  };
  const response = await fetch(
    "https://api-m.sandbox.paypal.com/v1/oauth2/token",
    {
      headers: {
        // CLIENT_ID: c.env.CLIENT_SECRET,
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      body: JSON.stringify(payload),
    },
  );

  const data = (await response.json()) as any;
  console.log(data);
  return data.access_token;
};
