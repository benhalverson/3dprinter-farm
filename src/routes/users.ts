import type { WebApiKey } from "cipher-kit";
// cipher-kit (web API variant) for new encryption format on profile endpoints
import {
  decrypt as ckDecrypt,
  encrypt as ckEncrypt,
  createSecretKey,
  isInWebApiEncryptionFormat,
} from "cipher-kit/web-api";
import { eq } from "drizzle-orm";
import { describeRoute } from "hono-openapi";
import { ProfileDataSchema, users } from "../db/schema";
import factory from "../factory";
import { authMiddleware } from "../utils/authMiddleware";
import { decryptField } from "../utils/crypto";

const userRouter = factory
  .createApp()

  .get(
    "/profile",
    describeRoute({
      description: "Get the profile of the authenticated user",
      tags: ["User"],
      responses: {
        200: { description: "User profile retrieved successfully" },
        401: { description: "Unauthorized" },
        404: { description: "User not found" },
      },
    }),
    authMiddleware,
    async c => {
      const user = c.get("jwtPayload") as { id: number; email: string };
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      // In-memory cache for derived secret keys (scoped per module load)
      const secretKeyCache: Map<string, WebApiKey> =
        (globalThis as any).__profileSecretKeyCache || new Map();
      (globalThis as any).__profileSecretKeyCache = secretKeyCache;

      const getSecretKey = async (passphrase: string): Promise<WebApiKey> => {
        if (secretKeyCache.has(passphrase))
          return secretKeyCache.get(passphrase)!;
        const res = await createSecretKey(passphrase);
        if (!res.success)
          throw new Error(
            `cipher-kit key derivation failed: ${res.error.message} - ${res.error.description}`,
          );
        secretKeyCache.set(passphrase, res.secretKey);
        return res.secretKey;
      };

      const decryptValue = async (
        value: string | null,
        passphrase: string,
        secretKey: WebApiKey,
      ): Promise<string | null> => {
        if (value == null || value === "") return value;
        try {
          // New format detection (cipher-kit web API: iv.encrypted.)
          if (isInWebApiEncryptionFormat(value)) {
            const dec = await ckDecrypt(value, secretKey);
            if (!dec.success)
              throw new Error(`cipher-kit decrypt error: ${dec.error.message}`);
            return dec.result as string;
          }
          // Legacy format (salt:iv:cipher) heuristic: contains two ':' separators
          if (value.includes(":") && value.split(":").length === 3) {
            return await decryptField(value, passphrase);
          }
          // Test/mocked or already-plaintext value (e.g. 'encrypted-test') => fall back to legacy decryptField for compatibility with mocks
          return await decryptField(value, passphrase);
        } catch (e) {
          console.warn(
            "Profile decrypt fallback triggered for value, returning empty string. Reason:",
            e,
          );
          return "";
        }
      };

      try {
        const [userData] = await c.var.db
          .select()
          .from(users)
          .where(eq(users.id, user.id));

        console.log("Fetched user data for ID:", user.id, userData);

        if (!userData) return c.json({ error: "User not found" }, 404);

        const passphrase = c.env.ENCRYPTION_PASSPHRASE;
        console.log("passphrase:", passphrase ? "***" : "(missing)");
        if (!passphrase)
          return c.json({ error: "Encryption passphrase missing" }, 500);
        const secretKey = await getSecretKey(passphrase);

        console.time("decrypt-profile");
        const decryptedProfile = {
          id: userData.id,
          email: userData.email,
          firstName: await decryptValue(
            userData.firstName,
            passphrase,
            secretKey,
          ),
          lastName: await decryptValue(
            userData.lastName,
            passphrase,
            secretKey,
          ),
          address: await decryptValue(
            userData.shippingAddress,
            passphrase,
            secretKey,
          ),
          city: await decryptValue(userData.city, passphrase, secretKey),
          state: await decryptValue(userData.state, passphrase, secretKey),
          zipCode: await decryptValue(userData.zipCode, passphrase, secretKey),
          country: await decryptValue(userData.country, passphrase, secretKey),
          phone: await decryptValue(userData.phone, passphrase, secretKey),
        };
        console.log(
          "Decrypted profile for user ID:",
          user.id,
          decryptedProfile,
        );
        console.timeEnd("decrypt-profile");
        return c.json(decryptedProfile);
      } catch (error: any) {
        console.log("Error fetching user data:", error);
        return c.json(
          { error: "Internal Server Error", details: error.message },
          500,
        );
      }
    },
  )
  .post(
    "/profile",
    authMiddleware,
    describeRoute({
      description:
        "Update the profile of the authenticated user (no id param required)",
      tags: ["User"],
      responses: {
        200: { description: "User profile updated successfully" },
        400: { description: "Validation failed" },
        404: { description: "User not found" },
        500: { description: "Internal Server Error" },
      },
    }),
    async c => {
      const authUser = c.get("jwtPayload") as { id: number; email: string };
      if (!authUser) return c.json({ error: "Unauthorized" }, 401);

      const body = await c.req.json();
      const validation = ProfileDataSchema.safeParse(body);
      if (!validation.success) {
        return c.json(
          { error: "Validation failed", details: validation.error.errors },
          400,
        );
      }

      const {
        firstName,
        lastName,
        shippingAddress,
        city,
        state,
        zipCode,
        phone,
        country,
      } = validation.data;

      const secretKeyCache: Map<string, WebApiKey> =
        (globalThis as any).__profileSecretKeyCache || new Map();
      (globalThis as any).__profileSecretKeyCache = secretKeyCache;
      const passphrase = c.env.ENCRYPTION_PASSPHRASE;
      if (!passphrase)
        return c.json({ error: "Encryption passphrase missing" }, 500);
      const getSecretKey = async (): Promise<WebApiKey> => {
        if (secretKeyCache.has(passphrase))
          return secretKeyCache.get(passphrase)!;
        const res = await createSecretKey(passphrase);
        if (!res.success)
          throw new Error(
            `cipher-kit key derivation failed: ${res.error.message} - ${res.error.description}`,
          );
        secretKeyCache.set(passphrase, res.secretKey);
        return res.secretKey;
      };

      const encryptValue = async (
        value: string | null,
        secretKey: WebApiKey,
      ): Promise<string | null> => {
        if (value == null || value === "") return value; // store empty/nullable as-is
        const enc = await ckEncrypt(value, secretKey);
        if (!enc.success)
          throw new Error(
            `cipher-kit encrypt error: ${enc.error.message} - ${enc.error.description}`,
          );
        return enc.result as string;
      };

      try {
        const secretKey = await getSecretKey();
        const [userData] = await c.var.db
          .update(users)
          .set({
            firstName: (await encryptValue(firstName, secretKey)) ?? "",
            lastName: (await encryptValue(lastName, secretKey)) ?? "",
            shippingAddress:
              (await encryptValue(shippingAddress, secretKey)) ?? "",
            city: (await encryptValue(city, secretKey)) ?? "",
            state: (await encryptValue(state, secretKey)) ?? "",
            zipCode: (await encryptValue(zipCode, secretKey)) ?? "",
            country: (await encryptValue(country, secretKey)) ?? "",
            phone: (await encryptValue(phone, secretKey)) ?? "",
          })
          .where(eq(users.id, authUser.id))
          .returning();

        if (!userData) return c.json({ error: "User not found" }, 404);

        return c.json({
          id: userData.id,
          email: userData.email,
          firstName,
          lastName,
          shippingAddress,
          city,
          state,
          zipCode,
          country,
          phone,
        });
      } catch (error: any) {
        console.error("Error updating user data (self profile):", error);
        return c.json(
          { error: "Internal Server Error", details: error.message },
          500,
        );
      }
    },
  )

  .post(
    "/profile/:id",
    authMiddleware,
    describeRoute({
      description:
        "Update the profile of a user by ID (must match authenticated user)",
      tags: ["User"],
      responses: {
        200: { description: "User profile updated successfully" },
        400: { description: "Validation failed" },
        403: { description: "Forbidden (ID mismatch)" },
        404: { description: "User not found" },
        500: { description: "Internal Server Error" },
      },
    }),
    async c => {
      const authUser = c.get("jwtPayload") as { id: number; email: string };
      const userIdParam = Number(c.req.param("id"));
      if (!authUser) return c.json({ error: "Unauthorized" }, 401);
      if (Number.isNaN(userIdParam)) {
        return c.json({ error: "Invalid user id" }, 400);
      }
      if (authUser.id !== userIdParam) {
        return c.json({ error: "Forbidden: cannot modify another user" }, 403);
      }
      const userId = userIdParam;
      const body = await c.req.json();
      const validation = ProfileDataSchema.safeParse(body);
      if (!validation.success) {
        return c.json(
          { error: "Validation failed", details: validation.error.errors },
          400,
        );
      }

      const {
        firstName,
        lastName,
        shippingAddress,
        city,
        state,
        zipCode,
        phone,
        country,
      } = validation.data;

      // Reuse global cache from GET path to avoid re-deriving secret key
      const secretKeyCache: Map<string, WebApiKey> =
        (globalThis as any).__profileSecretKeyCache || new Map();
      (globalThis as any).__profileSecretKeyCache = secretKeyCache;
      const passphrase = c.env.ENCRYPTION_PASSPHRASE;
      if (!passphrase)
        return c.json({ error: "Encryption passphrase missing" }, 500);
      const getSecretKey = async (): Promise<WebApiKey> => {
        if (secretKeyCache.has(passphrase))
          return secretKeyCache.get(passphrase)!;
        const res = await createSecretKey(passphrase);
        if (!res.success)
          throw new Error(
            `cipher-kit key derivation failed: ${res.error.message} - ${res.error.description}`,
          );
        secretKeyCache.set(passphrase, res.secretKey);
        return res.secretKey;
      };

      const encryptValue = async (
        value: string | null,
        secretKey: WebApiKey,
      ): Promise<string | null> => {
        if (value == null || value === "") return value; // store empty/nullable as-is
        const enc = await ckEncrypt(value, secretKey);
        if (!enc.success)
          throw new Error(
            `cipher-kit encrypt error: ${enc.error.message} - ${enc.error.description}`,
          );
        return enc.result as string;
      };

      try {
        const secretKey = await getSecretKey();
        const [userData] = await c.var.db
          .update(users)
          .set({
            firstName: (await encryptValue(firstName, secretKey)) ?? "",
            lastName: (await encryptValue(lastName, secretKey)) ?? "",
            shippingAddress:
              (await encryptValue(shippingAddress, secretKey)) ?? "",
            city: (await encryptValue(city, secretKey)) ?? "",
            state: (await encryptValue(state, secretKey)) ?? "",
            zipCode: (await encryptValue(zipCode, secretKey)) ?? "",
            country: (await encryptValue(country, secretKey)) ?? "",
            phone: (await encryptValue(phone, secretKey)) ?? "",
          })
          .where(eq(users.id, userId))
          .returning();
        console.log("Updated user data for ID:", userId);

        if (!userData) return c.json({ error: "User not found" }, 404);

        return c.json({
          id: userData.id,
          email: userData.email,
          firstName,
          lastName,
          shippingAddress,
          city,
          state,
          zipCode,
          country,
          phone,
        });
      } catch (error: unknown) {
        if (error instanceof Error) {
          return c.json(
            { error: "Internal Server Error", details: error.message },
            500,
          );
        }
      }
    },
  );

export default userRouter;
