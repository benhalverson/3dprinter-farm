import { zValidator } from "@hono/zod-validator";
import type { WebApiKey } from "cipher-kit";
import {
  decrypt as ckDecrypt,
  createSecretKey,
  isInWebApiEncryptionFormat,
} from "cipher-kit/web-api";
import { and, eq } from "drizzle-orm";
import { describeRoute } from "hono-openapi";

import { z } from "zod";
import { BASE_URL } from "../constants";
import { addCartItemSchema, cart, productsTable, users } from "../db/schema";
import factory from "../factory";
import { authMiddleware } from "../utils/authMiddleware";
import { decryptField } from "../utils/crypto";
import { generateOrderNumber } from "../utils/generateOrderNumber";

// Schema for update cart item
const updateCartItemSchema = z.object({
  cartId: z.string(),
  itemId: z.number(),
  quantity: z.number().min(0),
});

// Schema for remove cart item
const removeCartItemSchema = z.object({
  cartId: z.string(),
  itemId: z.number(),
});

const shoppingCart = factory
  .createApp()
  .get(
    "/cart/shipping",
    authMiddleware,
    describeRoute({
      description: "Get the shipping address for the logged-in user",
      tags: ["Shopping Cart"],
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                address: z
                  .object({
                    firstName: z.string(),
                    lastName: z.string(),
                    shippingAddress: z.string(),
                    city: z.string(),
                    state: z.string(),
                    zipCode: z.string(),
                    country: z.string(),
                    phone: z.string(),
                  })
                  .nullable(),
              }),
            },
          },
          description: "Shipping address retrieved successfully",
        },
        500: {
          content: {
            "application/json": {
              schema: z.object({ error: z.string() }),
            },
          },
          description: "Failed to retrieve shipping address",
        },
      },
    }),
    async c => {
      try {
        const jwtPayload = c.get("jwtPayload");
        const userId = jwtPayload?.id;
        if (!userId) return c.json({ error: "Unauthorized" }, 401);

        // Expect cartId as query param to know which cart to estimate
        const cartId = c.req.query("cartId");
        if (!cartId)
          return c.json({ error: "cartId query param required" }, 400);

        const [userRow] = await c.var.db
          .select()
          .from(users)
          .where(eq(users.id, userId));
        if (!userRow) return c.json({ error: "User not found" }, 404);

        const passphrase = c.env.ENCRYPTION_PASSPHRASE;
        if (!passphrase)
          return c.json({ error: "Encryption passphrase missing" }, 500);

        // Cache derived cipher-kit secret key across requests in worker lifetime
        const secretKeyCache: Map<string, WebApiKey> =
          (globalThis as any).__shippingSecretKeyCache || new Map();
        (globalThis as any).__shippingSecretKeyCache = secretKeyCache;
        const getSecretKey = async () => {
          if (secretKeyCache.has(passphrase))
            return secretKeyCache.get(passphrase)!;
          const res = await createSecretKey(passphrase);
          if (!res.success)
            throw new Error(
              `cipher-kit key derivation failed: ${res.error.message}`,
            );
          secretKeyCache.set(passphrase, res.secretKey);
          return res.secretKey;
        };
        let secretKey: WebApiKey | undefined;

        const decryptMaybe = async (
          value: unknown,
          field: string,
        ): Promise<string> => {
          if (typeof value !== "string" || value.length === 0) return "";
          // cipher-kit format detection
          if (isInWebApiEncryptionFormat(value)) {
            try {
              secretKey = secretKey || (await getSecretKey());
              const dec = await ckDecrypt(value, secretKey);
              if (dec.success) return dec.result as string;
              console.warn(
                `[decryptMaybe] cipher-kit decrypt failed for ${field}:`,
                dec.error?.message,
              );
              return "";
            } catch (e) {
              console.warn(
                `[decryptMaybe] cipher-kit exception for ${field}:`,
                (e as Error).message,
              );
              return "";
            }
          }
          // legacy salt:iv:cipher
          if (value.includes(":") && value.split(":").length === 3) {
            try {
              return await decryptField(value, passphrase);
            } catch (e) {
              console.warn(
                `[decryptMaybe] legacy decrypt failed for ${field}:`,
                (e as Error).message,
              );
              return "";
            }
          }
          // treat as plaintext
          return value;
        };

        const firstName = await decryptMaybe(userRow.firstName, "firstName");
        const lastName = await decryptMaybe(userRow.lastName, "lastName");
        const email =
          (await decryptMaybe(userRow.email, "email")) || userRow.email || "";
        const shippingAddress = await decryptMaybe(
          userRow.shippingAddress,
          "shippingAddress",
        );
        const city = await decryptMaybe(userRow.city, "city");
        const state = await decryptMaybe(userRow.state, "state");
        const zipCode = await decryptMaybe(userRow.zipCode, "zipCode");
        const _country = await decryptMaybe(userRow.country, "country");
        let phone = await decryptMaybe(userRow.phone, "phone");
        // Additional heuristic: if phone still looks like an encoded blob (contains '.' segments, not many digits)
        if (
          phone?.includes(".") &&
          !/\d{5,}/.test(phone) &&
          phone.length > 15
        ) {
          try {
            secretKey = secretKey || (await getSecretKey());
            const dec2 = await ckDecrypt(phone, secretKey);
            if (dec2.success && typeof dec2.result === "string") {
              phone = dec2.result as string;
            }
          } catch (e) {
            console.warn(
              "[phone decrypt] Heuristic decrypt attempt failed:",
              (e as Error).message,
            );
          }
        }
        // Sanitize phone - keep digits and leading +, enforce <=20 chars
        phone = phone ? phone.replace(/[^+0-9]/g, "") : "";
        if (phone.length > 20) phone = phone.slice(0, 20);
        if (!phone) phone = "0000000000"; // fallback minimal placeholder if upstream requires

        // Pull cart contents and join products to enrich data.
        const cartItems = await c.var.db
          .select({
            id: cart.id,
            skuNumber: cart.skuNumber,
            quantity: cart.quantity,
            color: cart.color,
            filamentType: cart.filamentType,
            productName: productsTable.name,
            stl: productsTable.stl,
          })
          .from(cart)
          .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
          .where(eq(cart.cartId, cartId));

        console.log("cartItems:", cartItems);

        if (cartItems.length === 0) {
          return c.json({ error: "Cart empty or not found" }, 404);
        }

        // Build orderData array per API spec from each cart item.
        // Normalize colors to allowed enumeration expected by upstream API.
        const allowedColors = new Set([
          "black",
          "white",
          "gray",
          "grey",
          "yellow",
          "red",
          "gold",
          "purple",
          "blue",
          "orange",
          "green",
          "pink",
          "matteBlack",
          "lunarRegolith",
          "petgBlack",
        ]);
        const hexToNameMap: Record<string, string> = {
          "#000000": "black",
          "#ffffff": "white",
          "#fff": "white",
          "#000": "black",
          "#808080": "gray",
          "#808081": "gray",
          "#ff0000": "red",
          "#ffff00": "yellow",
          "#ffa500": "orange",
          "#00ff00": "green",
          "#008000": "green",
          "#0000ff": "blue",
          "#800080": "purple",
          "#ffc0cb": "pink",
          "#ffd700": "gold",
        };
        const normalizeColor = (raw: string | null | undefined): string => {
          if (!raw) return "black";
          const trimmed = raw.trim();
          // Already an allowed value (case sensitive match first)
          if (allowedColors.has(trimmed)) return trimmed;
          // Try case-insensitive simple colors
          const lower = trimmed.toLowerCase();
          for (const c of allowedColors) {
            if (c.toLowerCase() === lower) return c; // preserve canonical casing
          }
          // Attempt hex normalization
          let candidate = lower;
          if (
            !candidate.startsWith("#") &&
            /^([0-9a-f]{3}|[0-9a-f]{6})$/.test(candidate)
          ) {
            candidate = `#${candidate}`;
          }
          // Fix malformed 5-char like '#00000' by padding
          if (/^#[0-9a-f]{5}$/i.test(candidate)) candidate = `${candidate}0`;
          const mapped = hexToNameMap[candidate];
          if (mapped && allowedColors.has(mapped)) return mapped;
          // Map special marketing names ignoring case
          if (lower === "matteblack") return "matteBlack";
          if (lower === "lunarregolith") return "lunarRegolith";
          if (lower === "petgblack" || lower === "petg_black")
            return "petgBlack";
          return "black"; // safe fallback
        };

        const orderDataArray = cartItems.map(cart => {
          // Derive filename: use product STL last path segment or fallback.
          const stlPath = cart.stl;
          const filenameCandidate = stlPath?.split("/").pop();
          const normalizedColor = normalizeColor(cart.color);
          if (normalizedColor !== cart.color) {
            console.log("Normalized color", {
              original: cart.color,
              normalized: normalizedColor,
            });
          }
          return {
            email,
            phone,
            name: `${firstName} ${lastName}`.trim(),
            orderNumber: generateOrderNumber(),
            filename: filenameCandidate,
            fileURL: stlPath,
            bill_to_street_1: shippingAddress,
            bill_to_street_2: "",
            bill_to_street_3: "",
            bill_to_city: city,
            bill_to_state: state,
            bill_to_zip: zipCode,
            bill_to_country_as_iso: "US",
            bill_to_is_US_residential: "true",
            ship_to_name: `${firstName} ${lastName}`.trim(),
            ship_to_street_1: shippingAddress,
            ship_to_street_2: "",
            ship_to_street_3: "",
            ship_to_city: city,
            ship_to_state: state,
            ship_to_zip: zipCode,
            ship_to_country_as_iso: "US",
            ship_to_is_US_residential: "true",
            order_item_name: cart.productName,
            order_quantity: String(cart.quantity),
            order_image_url: "",
            order_sku: cart.skuNumber,
            order_item_color: normalizedColor,
            profile: cart.filamentType,
          };
        });

        // API expects an array of orderData objects
        const response = await fetch(`${BASE_URL}order/estimate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "api-key": c.env.SLANT_API,
          },
          body: JSON.stringify(orderDataArray),
        });

        if (!response.ok) {
          console.error(
            "Upstream estimate error:",
            response.status,
            await response.text(),
          );
          return c.json(
            { error: "Upstream estimate failed", status: response.status },
            502,
          );
        }

        const data = (await response.json()) as ShippingResponse;
        return c.json({ shippingCost: data.shippingCost });
      } catch (err: any) {
        console.log("Error fetching shipping estimate:", err);
        return c.json(
          {
            error: "Failed to retrieve shipping estimate",
            details: err?.message,
          },
          500,
        );
      }
    },
  )

  .post(
    "/cart/create",
    describeRoute({
      description: "Create a new shopping cart",
      tags: ["Shopping Cart"],
      responses: {
        201: {
          content: {
            "application/json": {
              schema: z.object({
                cartId: z.string().uuid(),
                message: z.string(),
              }),
            },
          },
          description: "Cart created successfully",
        },
      },
    }),
    async c => {
      try {
        const cartId = crypto.randomUUID();
        return c.json(
          {
            cartId,
            message: "Cart created successfully",
          },
          201,
        );
      } catch (_error) {
        return c.json({ error: "Failed to create cart" }, 500);
      }
    },
  )
  .get(
    "/cart/:cartId",
    describeRoute({
      description: "Get shopping cart items",
      tags: ["Shopping Cart"],
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(
                  z.object({
                    id: z.number(),
                    productId: z.string(),
                    quantity: z.number(),
                    color: z.string(),
                    filamentType: z.string(),
                    name: z.string(),
                    price: z.number(),
                    stripePriceId: z.string().optional(),
                  }),
                ),
                total: z.number(),
              }),
            },
          },
          description: "Cart items retrieved successfully",
        },
        404: {
          content: {
            "application/json": {
              schema: z.object({
                error: z.string(),
              }),
            },
          },
          description: "Cart not found",
        },
      },
    }),
    async c => {
      const cartId = c.req.param("cartId");

      try {
        // Join cart with products to get pricing, name, and Stripe information
        const items = await c.var.db
          .select({
            id: cart.id,
            cartId: cart.cartId,
            skuNumber: cart.skuNumber,
            quantity: cart.quantity,
            color: cart.color,
            filamentType: cart.filamentType,
            name: productsTable.name,
            price: productsTable.price,
            stripePriceId: productsTable.stripePriceId,
          })
          .from(cart)
          .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
          .where(eq(cart.cartId, cartId));

        const total = items.reduce(
          (sum, item) => sum + item.quantity * (item.price || 0),
          0,
        );

        return c.json({
          items: items.map(item => ({
            id: item.id,
            productId: item.skuNumber,
            quantity: item.quantity,
            color: item.color,
            filamentType: item.filamentType,
            name: item.name,
            price: item.price,
            stripePriceId: item.stripePriceId,
          })),
          total,
        });
      } catch (_error) {
        return c.json({ error: "Failed to retrieve cart items" }, 500);
      }
    },
  )
  .post(
    "/cart/add",
    describeRoute({
      description: "Add item to cart",
      tags: ["Shopping Cart"],
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                message: z.string(),
              }),
            },
          },
          description: "Item added successfully",
        },
        500: {
          content: {
            "application/json": {
              schema: z.object({
                error: z.string(),
              }),
            },
          },
          description: "Failed to add item",
        },
      },
    }),
    zValidator("json", addCartItemSchema),
    async c => {
      const { cartId, skuNumber, quantity, color, filamentType } =
        c.req.valid("json");

      try {
        const existing = await c.var.db.query.cart.findFirst({
          where: and(
            eq(cart.cartId, cartId),
            eq(cart.skuNumber, skuNumber),
            eq(cart.color, color),
            eq(cart.filamentType, filamentType),
          ),
        });

        if (existing) {
          await c.var.db
            .update(cart)
            .set({
              quantity: existing.quantity + quantity,
            })
            .where(eq(cart.id, existing.id));
        } else {
          await c.var.db.insert(cart).values({
            cartId,
            skuNumber: skuNumber,
            quantity,
            color,
            filamentType,
          });
        }

        return c.json({ message: "Item added to cart successfully" });
      } catch (_error) {
        return c.json({ error: "Failed to add item to cart" }, 500);
      }
    },
  )
  .put(
    "/cart/update",
    describeRoute({
      description: "Update cart item quantity",
      tags: ["Shopping Cart"],
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                message: z.string(),
              }),
            },
          },
          description: "Cart item updated successfully",
        },
        400: {
          content: {
            "application/json": {
              schema: z.object({
                error: z.string(),
              }),
            },
          },
          description: "Invalid request",
        },
      },
    }),
    zValidator("json", updateCartItemSchema),
    async c => {
      const { cartId, itemId, quantity } = c.req.valid("json");

      try {
        // First, let's see what items exist in this cart
        const existingItems = await c.var.db.query.cart.findMany({
          where: eq(cart.cartId, cartId),
        });

        if (quantity === 0) {
          const _deleteResult = await c.var.db
            .delete(cart)
            .where(and(eq(cart.id, itemId), eq(cart.cartId, cartId)));
          return c.json({ message: "Cart item removed successfully" });
        } else {
          const updateResult = await c.var.db
            .update(cart)
            .set({ quantity })
            .where(and(eq(cart.id, itemId), eq(cart.cartId, cartId)));

          // Check if any rows were affected
          if (updateResult.changes === 0) {
            return c.json(
              {
                error: "No cart item found with that ID",
                debug: {
                  itemId,
                  cartId,
                  existingItems,
                },
              },
              404,
            );
          }

          return c.json({ message: "Cart item updated successfully" });
        }
      } catch (error) {
        console.error("Update error:", error);
        return c.json({ error: "Failed to update cart item" }, 500);
      }
    },
  )
  .delete(
    "/cart/remove",
    describeRoute({
      description: "Remove item from cart",
      tags: ["Shopping Cart"],
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                message: z.string(),
              }),
            },
          },
          description: "Item removed from cart successfully",
        },
        400: {
          content: {
            "application/json": {
              schema: z.object({
                error: z.string(),
              }),
            },
          },
          description: "Invalid request",
        },
      },
    }),
    zValidator("json", removeCartItemSchema),
    async c => {
      const { cartId, itemId } = c.req.valid("json");

      try {
        await c.var.db
          .delete(cart)
          .where(and(eq(cart.id, itemId), eq(cart.cartId, cartId)));

        return c.json({ message: "Item removed from cart successfully" });
      } catch (_error) {
        return c.json({ error: "Failed to remove item from cart" }, 500);
      }
    },
  )
  .get(
    "/cart/:cartId/stripe-items",
    describeRoute({
      description: "Get cart items formatted for Stripe checkout",
      tags: ["Shopping Cart", "Stripe"],
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                line_items: z.array(
                  z.object({
                    price: z.string(),
                    quantity: z.number(),
                  }),
                ),
              }),
            },
          },
          description: "Stripe line items retrieved successfully",
        },
        404: {
          content: {
            "application/json": {
              schema: z.object({
                error: z.string(),
              }),
            },
          },
          description: "Cart not found or no Stripe price IDs available",
        },
      },
    }),
    async c => {
      const cartId = c.req.param("cartId");

      try {
        // Join cart with products to get Stripe price IDs
        const items = await c.var.db
          .select({
            stripePriceId: productsTable.stripePriceId,
            quantity: cart.quantity,
          })
          .from(cart)
          .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
          .where(eq(cart.cartId, cartId));

        // Filter items that have Stripe price IDs
        const stripeItems = items
          .filter(item => item.stripePriceId)
          .map(item => ({
            price: item.stripePriceId!,
            quantity: item.quantity,
          }));

        if (stripeItems.length === 0) {
          return c.json({ error: "No items with Stripe price IDs found" }, 404);
        }

        return c.json({ line_items: stripeItems });
      } catch (_error) {
        return c.json({ error: "Failed to retrieve Stripe items" }, 500);
      }
    },
  );
export default shoppingCart;

interface ShippingResponse {
  shippingCost: number;
  currencyCode: string;
}
