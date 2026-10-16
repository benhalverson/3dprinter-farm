import { z } from 'zod';
import { type CatalogItem, catalogItemSchema, safeImage } from './catalog';
import { bytes, MAX_BYTES, ShoppingFailure } from './contracts';

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
const nodeSchema = z.discriminatedUnion('component', [
  z
    .object({
      id: z.literal('products'),
      component: z.literal('ProductRail'),
      entries: z.array(id).max(12),
    })
    .strict(),
  z.object({ id, component: z.literal('ProductEntry'), product }).strict(),
  z
    .object({
      id: z.literal('focus'),
      component: z.literal('ProductFocus'),
      product: product.nullable(),
      images: z.array(id).max(1),
    })
    .strict(),
  z.object({ id, component: z.literal('DetailImage'), product }).strict(),
]);
/** Model-facing composition language: only public record paths, no arbitrary text, actions or URLs. */
export const compositionSchema = z
  .object({
    components: z.array(nodeSchema).min(2).max(16),
    answer: z.enum(['catalog', 'fit_unknown', 'policy_unknown']),
  })
  .strict();
export type Composition = z.input<typeof compositionSchema>;
export const CATALOG_PATH = '/agentCatalog';
export const CATALOG_ID = 'https://luluspeedworks.com/catalog/scaffold/v1';
export const LIMITATIONS = {
  fit_unknown:
    'Compatibility is not supplied by this catalog. Verify fit before purchasing.',
  policy_unknown:
    'Shipping, returns and other store policies are not supplied by this catalog.',
  catalog:
    'Catalog facts are shown below. Compatibility and store policies are not verified.',
};
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

type Component = {
  id: string;
  component: string;
  [key: string]:
    | string
    | boolean
    | string[]
    | { event: { name: string } }
    | { path: string };
};

/**
 * Validate a model-selected graph and bind only authoritative public catalog facts.
 * An empty rail can coexist with a focused product; no-match copy requires both
 * to be empty. Invalid references or unsupported output fail closed.
 */
export function compose(raw: string, catalog: CatalogItem[]) {
  try {
    if (bytes(raw) > MAX_BYTES) throw new Error('oversized');
    const plan = compositionSchema.parse(JSON.parse(raw));
    const nodes = new Map(plan.components.map(node => [node.id, node]));
    if (nodes.size !== plan.components.length) throw new Error('duplicate_id');
    const rail = nodes.get('products');
    const focus = nodes.get('focus');
    if (
      rail?.component !== 'ProductRail' ||
      focus?.component !== 'ProductFocus'
    )
      throw new Error('missing_region');
    const referenced = new Set(['products', 'focus']);
    for (const child of rail.entries) {
      if (
        nodes.get(child)?.component !== 'ProductEntry' ||
        referenced.has(child)
      )
        throw new Error('invalid_reference');
      referenced.add(child);
    }
    for (const child of focus.images) {
      const image = nodes.get(child);
      if (
        image?.component !== 'DetailImage' ||
        image.product !== focus.product ||
        referenced.has(child)
      )
        throw new Error('invalid_image');
      referenced.add(child);
    }
    if (referenced.size !== nodes.size) throw new Error('unreachable');
    const records = new Map(catalog.map(item => [item.id, item]));
    const products: Record<string, z.infer<typeof publicProductSchema>> = {};
    const fact = (key: number) => {
      if (!products[key]) {
        const item = catalogItemSchema.parse(records.get(key));
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
      return (field: string) => ({
        path: `${CATALOG_PATH}/products/${key}/${field}`,
      });
    };
    const components = plan.components.map((node): Component => {
      if (node.component === 'ProductRail')
        return {
          id: node.id,
          component: node.component,
          controls: [],
          entries: node.entries,
          status:
            node.entries.length || focus.product !== null
              ? LIMITATIONS[plan.answer]
              : `No matching products were found in the catalog. ${LIMITATIONS[plan.answer]}`,
          paging: '',
          previousDisabled: true,
          nextDisabled: true,
          retryVisible: false,
          previous: { event: { name: 'previous' } },
          next: { event: { name: 'next' } },
          retry: { event: { name: 'retry' } },
        };
      if (node.component === 'ProductFocus') {
        const item = node.product === null ? null : fact(node.product);
        return {
          id: node.id,
          component: node.component,
          title: 'Catalog guidance',
          description: LIMITATIONS[plan.answer],
          selectedTitle: item ? item('name') : '',
          selectedDescription: item ? item('description') : '',
          href: item ? item('href') : '',
          active: item !== null,
          ready: item !== null,
          price: item ? item('price') : '',
          sku: item ? item('sku') : '',
          compatibility: item ? item('compatibility') : LIMITATIONS.fit_unknown,
          images: node.images,
          retryVisible: false,
          retry: { event: { name: 'retry-product' } },
        };
      }
      const item = fact(node.product);
      if (node.component === 'DetailImage')
        return {
          id: node.id,
          component: node.component,
          src: item('image'),
          name: item('name'),
        };
      return {
        id: node.id,
        component: node.component,
        name: item('name'),
        description: item('description'),
        price: item('price'),
        image: item('image'),
        href: item('href'),
      };
    });
    const messages = [
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
    ] as const;
    const batch = {
      catalogId: CATALOG_ID,
      messages,
      limitations: [
        LIMITATIONS[plan.answer],
        LIMITATIONS.fit_unknown,
        LIMITATIONS.policy_unknown,
      ],
    };
    if (bytes(JSON.stringify(batch)) > MAX_BYTES)
      throw new Error('oversized_batch');
    return batch;
  } catch {
    throw new ShoppingFailure('invalid_output');
  }
}
