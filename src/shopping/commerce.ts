import { checkoutTools, checkoutDefinitions } from './checkout-tools';
import { asc, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { cart, productsTable } from '../db/schema';
import type { WorkerEnv } from '../factory';
import { validateCartConfiguration } from '../modules/cartConfiguration';
import {
  addCartLine,
  removeCartLine,
  setCartLineQuantity,
  readCartAction,
} from '../modules/cartMutations';
import {
  cartLines,
  requireCartAccess,
  type CartCaller,
} from '../modules/cartOwnership';
import { BASE_URL_V2 } from '../constants';
import { digest, type RunInput } from './contracts';

type Database = WorkerEnv['Variables']['db'];
const productId = z.number().int().positive().safe();
const querySchema = z.discriminatedUnion('name', [
  z
    .object({
      name: z.literal('selection_options'),
      arguments: z.object({ productId }).strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal('selection_set'),
      arguments: z
        .object({
          productId,
          filamentId: z.string().uuid(),
          quantity: z.number().int().min(1).max(69),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal('cart_add'),
      arguments: z
        .object({
          productId,
          filamentId: z.string().uuid(),
          quantity: z.number().int().min(1).max(69),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal('cart_set_quantity'),
      arguments: z
        .object({
          itemId: productId,
          quantity: z.number().int().min(0).max(69),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal('cart_remove'),
      arguments: z.object({ itemId: productId }).strict(),
    })
    .strict(),
]);
const colorSchema = z.object({
  publicId: z.string().uuid(),
  profile: z.string(),
  color: z.string(),
  hexValue: z.string(),
  provider: z.string(),
  available: z.boolean(),
});
const cartStateSchema = z.object({
  cartId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      id: z.number().int(),
      productId: z.number().int().nullable(),
      name: z.string().nullable(),
      quantity: z.number().int(),
      filamentId: z.string().nullable(),
      color: z.string().nullable(),
      material: z.string(),
      unitPrice: z.number().nullable(),
    }),
  ),
});
export async function authoritativeCart(
  db: Database,
  cartId: string,
  caller: CartCaller,
) {
  const access = await requireCartAccess(db, cartId, caller);
  const items = await db
    .select({
      id: cart.id,
      productId: productsTable.id,
      name: productsTable.name,
      quantity: cart.quantity,
      filamentId: cart.filamentId,
      color: cart.color,
      material: cart.filamentType,
      unitPrice: productsTable.price,
    })
    .from(cart)
    .leftJoin(productsTable, eq(cart.skuNumber, productsTable.skuNumber))
    .where(cartLines(access))
    .orderBy(asc(cart.id));
  // A later direct action may have overtaken the read: only expose one revision.
  const latest = await requireCartAccess(db, cartId, caller);
  if (latest.revision !== access.revision)
    throw new HTTPException(409, {
      message: 'Cart changed; reload before retrying',
    });
  return cartStateSchema.parse({ cartId, revision: access.revision, items });
}
const integer = { type: 'integer', minimum: 1 };
export type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};
export const commerceDefinitions: ToolDefinition[] = [
  {
    name: 'selection_options',
    description:
      'Read fixed material and currently available colors for one exact catalog product. Clarify ambiguous product/color references; never guess.',
    properties: { productId: integer },
  },
  {
    name: 'selection_set',
    description:
      'Choose an available color and quantity for the selected catalog product without changing the cart.',
    properties: {
      productId: integer,
      filamentId: { type: 'string', format: 'uuid' },
      quantity: { type: 'integer', minimum: 1, maximum: 69 },
    },
  },
  {
    name: 'cart_add',
    description:
      'Add quantity of an exact product and one available filament returned by selection_options. At most one cart mutation per run.',
    properties: {
      productId: integer,
      filamentId: { type: 'string', format: 'uuid' },
      quantity: { type: 'integer', minimum: 1, maximum: 69 },
    },
  },
  {
    name: 'cart_set_quantity',
    description:
      'Set an existing line to an absolute quantity (zero removes). At most one cart mutation per run.',
    properties: {
      itemId: integer,
      quantity: { type: 'integer', minimum: 0, maximum: 69 },
    },
  },
  {
    name: 'cart_remove',
    description:
      'Remove one exact cart line. At most one cart mutation per run.',
    properties: { itemId: integer },
  },
].map(({ name, description, properties }) => ({
  type: 'function' as const,
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  },
}));
export type CommerceTools = {
  definitions?: ToolDefinition[];
  context: unknown;
  execute: (query: unknown) => Promise<unknown>;
};
/** Identity comes from verified transport, never prompts or model arguments. */
export async function commerceTools(
  db: Database,
  env: WorkerEnv['Bindings'],
  caller: CartCaller,
  input: RunInput,
  sessionId: string,
  active: () => boolean,
  publish: (value: unknown) => void,
): Promise<CommerceTools | undefined> {
  const checkout = caller.userId
    ? checkoutTools(db, env, caller.userId, input, active, publish)
    : undefined;
  if (!input.cart) return checkout;
  const { id: cartId, revision } = input.cart;
  const initial = await authoritativeCart(db, cartId, caller);
  if (initial.revision !== revision)
    throw new HTTPException(409, {
      message: 'Cart changed; reload before retrying',
    });
  const options = new Map<
    number,
    {
      product: typeof productsTable.$inferSelect;
      colors: z.infer<typeof colorSchema>[];
    }
  >();
  let mutated = false;
  return {
    definitions: [...commerceDefinitions, ...(checkout?.definitions ?? [])],
    context: {
      ...initial,
      selection: input.selection ?? null,
      checkout: checkout?.context,
    },
    async execute(raw) {
      if (
        checkout &&
        raw &&
        typeof raw === 'object' &&
        'name' in raw &&
        checkoutDefinitions.some(tool => tool.function.name === raw.name)
      )
        return checkout.execute(raw);
      const query = querySchema.parse(raw);
      if (!active())
        throw new HTTPException(409, { message: 'Run superseded' });
      const access = await requireCartAccess(db, cartId, caller);
      if (access.revision !== revision && !mutated)
        throw new HTTPException(409, {
          message: 'Cart changed; reload before retrying',
        });
      if (query.name === 'selection_options') {
        const product = await db
          .select()
          .from(productsTable)
          .where(eq(productsTable.id, query.arguments.productId))
          .get();
        if (!product?.skuNumber || !product.filamentType)
          return {
            status: 'clarify',
            reason: 'Product has no available fixed material',
          };
        const cached = await env.COLOR_CACHE.get(
          `v2:colors:${product.filamentType}:true:all`,
        );
        const response = cached
          ? JSON.parse(cached)
          : await (
              await fetch(`${BASE_URL_V2}filaments`, {
                headers: { Authorization: `Bearer ${env.SLANT_API_V2}` },
                signal: AbortSignal.timeout(10000),
              })
            ).json();
        const colors = z
          .object({ success: z.literal(true), data: z.array(colorSchema) })
          .parse(response)
          .data.filter(
            color =>
              color.available &&
              color.profile === product.filamentType &&
              color.provider.toLowerCase() === 'slant 3d',
          );
        options.set(product.id, { product, colors });
        return {
          productId: product.id,
          name: product.name,
          material: product.filamentType,
          colors: colors.map(color => ({
            filamentId: color.publicId,
            color: color.color,
            hex: color.hexValue,
          })),
        };
      }
      if (query.name === 'selection_set') {
        const chosen = options.get(query.arguments.productId);
        const color = chosen?.colors.find(
          color => color.publicId === query.arguments.filamentId,
        );
        if (!chosen || !color)
          return {
            status: 'clarify',
            reason: 'Choose an available color for an exact product',
          };
        if (
          !active() ||
          (await requireCartAccess(db, cartId, caller)).revision !== revision
        )
          throw new HTTPException(409, { message: 'Cart changed' });
        const result = {
          status: 'selected',
          selection: {
            productId: chosen.product.id,
            material: chosen.product.filamentType,
            filamentId: color.publicId,
            color: color.hexValue,
            quantity: query.arguments.quantity,
          },
        };
        publish(result);
        return result;
      }
      if (mutated)
        throw new HTTPException(409, {
          message: 'Only one cart mutation is allowed per run',
        });
      const identity = {
        id: `${cartId}:${sessionId}:${input.runId}`,
        inputHash: await digest(JSON.stringify({ revision, query })),
        expectedRevision: revision,
        active,
      };
      if (query.name === 'cart_add') {
        const chosen = options.get(query.arguments.productId);
        const color = chosen?.colors.find(
          color => color.publicId === query.arguments.filamentId,
        );
        if (!chosen || !color)
          throw new HTTPException(400, {
            message: 'Read and select an available product color first',
          });
        const selection = {
          cartId,
          skuNumber: chosen.product.skuNumber!,
          quantity: query.arguments.quantity,
          color: color.hexValue,
          filamentType: chosen.product.filamentType!,
          filamentId: color.publicId,
        };
        await validateCartConfiguration(db, env, selection);
        await addCartLine(db, access, selection, identity);
      } else if (query.name === 'cart_remove')
        await removeCartLine(db, access, query.arguments.itemId, identity);
      else
        await setCartLineQuantity(
          db,
          access,
          query.arguments.itemId,
          query.arguments.quantity,
          identity,
        );
      mutated = true;
      const state = await authoritativeCart(db, cartId, caller);
      const receipt = await readCartAction(db, access, identity.id);
      const result = {
        status: 'applied',
        appliedRevision: receipt!.revision,
        cart: state,
      };
      if (active()) publish(result);
      return result;
    },
  };
}
