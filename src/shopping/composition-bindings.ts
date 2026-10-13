import { z } from 'zod';
import { type CatalogItem, catalogItemSchema, safeImage } from './catalog';
import { compose, compositionSchema, LIMITATIONS } from './composition';
import { bytes, MAX_BYTES, ShoppingFailure } from './contracts';

export const BINDING_CONTRACT = 'lulu.a2ui.v2';
export const CATALOG_PATH = '/agentCatalog';
const id = z.string().regex(/^agent-[a-z0-9-]{1,40}$/);
const product = z
  .object({
    path: z.string().regex(/^\/agentCatalog\/products\/[1-9]\d*$/),
  })
  .strict()
  .transform(value =>
    Number(value.path.slice('/agentCatalog/products/'.length)),
  )
  .pipe(z.number().int().positive().safe());

/** Models select a public record, never individual fact paths or data values. */
const planSchema = z
  .object({
    answer: compositionSchema.shape.answer,
    components: z
      .array(
        z.discriminatedUnion('component', [
          z
            .object({
              id: z.literal('products'),
              component: z.literal('ProductRail'),
              entries: z.array(id).max(12),
            })
            .strict(),
          z
            .object({ id, component: z.literal('ProductEntry'), product })
            .strict(),
          z
            .object({
              id: z.literal('focus'),
              component: z.literal('ProductFocus'),
              product: product.nullable(),
              images: z.array(id).max(1),
            })
            .strict(),
          z
            .object({ id, component: z.literal('DetailImage'), product })
            .strict(),
        ]),
      )
      .min(2)
      .max(16),
  })
  .strict()
  .transform(value =>
    compositionSchema.parse({
      ...value,
      components: value.components.map(node => {
        if (!('product' in node)) return node;
        const { product, ...component } = node;
        return { ...component, productId: product };
      }),
    }),
  );

const publicProductSchema = z
  .object({
    id: z.number().int().positive().safe(),
    name: z.string().max(512),
    description: z.string().max(4096),
    image: z.string().max(2048),
    price: z.string().max(128),
    sku: z.string().max(8192),
    href: z.string().regex(/^\/products\/[1-9]\d*$/),
    compatibility: z.string().max(8192),
  })
  .strict();

// Each field has exactly one sanctioned source on the component's selected record.
const fields = {
  ProductEntry: {
    name: 'name',
    description: 'description',
    image: 'image',
    price: 'price',
    href: 'href',
  },
  ProductFocus: {
    selectedTitle: 'name',
    selectedDescription: 'description',
    price: 'price',
    sku: 'sku',
    href: 'href',
    compatibility: 'compatibility',
  },
  DetailImage: { src: 'image', name: 'name' },
} as const;

/**
 * Compile an allowlisted record binding into a complete, bounded public snapshot
 * and graph. Nothing is published until both validate; v1 remains unchanged.
 */
export function composeBindings(raw: string, catalog: CatalogItem[]) {
  try {
    if (bytes(raw) > MAX_BYTES) throw new Error('oversized');
    const plan = planSchema.parse(JSON.parse(raw));
    const literal = compose(JSON.stringify(plan), catalog);
    const records = new Map(catalog.map(item => [item.id, item]));
    const products: Record<string, z.infer<typeof publicProductSchema>> = {};
    const components = literal.messages[0].updateComponents.components.map(
      (component, index) => {
        const node = plan.components[index];
        if (!('productId' in node) || node.productId === null) return component;
        const key = String(node.productId);
        if (!products[key]) {
          const item = catalogItemSchema.parse(records.get(node.productId));
          products[key] = publicProductSchema.parse({
            id: item.id,
            name: item.name,
            description: item.description,
            image: safeImage(item.image),
            price: new Intl.NumberFormat('en-US', {
              style: 'currency',
              currency: 'USD',
            }).format(item.price),
            sku: item.sku,
            href: `/products/${item.id}`,
            compatibility: item.fit ?? LIMITATIONS.fit_unknown,
          });
        }
        return {
          ...component,
          ...Object.fromEntries(
            Object.entries(fields[node.component]).map(([field, source]) => [
              field,
              { path: `${CATALOG_PATH}/products/${key}/${source}` },
            ]),
          ),
        };
      },
    );
    const batch = {
      ...literal,
      messages: [
        {
          version: 'v0.9.1' as const,
          updateDataModel: {
            surfaceId: 'storefront' as const,
            path: CATALOG_PATH,
            value: { products },
          },
        },
        {
          version: 'v0.9.1' as const,
          updateComponents: { surfaceId: 'storefront' as const, components },
        },
      ] as const,
    };
    if (bytes(JSON.stringify(batch)) > MAX_BYTES)
      throw new Error('oversized_batch');
    return batch;
  } catch {
    throw new ShoppingFailure('invalid_output');
  }
}
