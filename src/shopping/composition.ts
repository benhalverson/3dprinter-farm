import { z } from 'zod';
import { type CatalogItem, safeImage } from './catalog';
import { bytes, MAX_BYTES, ShoppingFailure } from './contracts';

const id = z.string().regex(/^agent-[a-z0-9-]{1,40}$/);
const productId = z.number().int().positive().safe();
const nodeSchema = z.discriminatedUnion('component', [
  z
    .object({
      id: z.literal('products'),
      component: z.literal('ProductRail'),
      entries: z.array(id).max(12),
    })
    .strict(),
  z.object({ id, component: z.literal('ProductEntry'), productId }).strict(),
  z
    .object({
      id: z.literal('focus'),
      component: z.literal('ProductFocus'),
      productId: productId.nullable(),
      images: z.array(id).max(1),
    })
    .strict(),
  z.object({ id, component: z.literal('DetailImage'), productId }).strict(),
]);
/** Model-facing composition language: no arbitrary text, actions, URLs or bindings. */
export const compositionSchema = z
  .object({
    components: z.array(nodeSchema).min(2).max(16),
    answer: z.enum(['catalog', 'fit_unknown', 'policy_unknown']),
  })
  .strict();
export type Composition = z.infer<typeof compositionSchema>;
export const CATALOG_ID = 'https://luluspeedworks.com/catalog/scaffold/v1';
export const LIMITATIONS = {
  fit_unknown:
    'Compatibility is not supplied by this catalog. Verify fit before purchasing.',
  policy_unknown:
    'Shipping, returns and other store policies are not supplied by this catalog.',
  catalog:
    'Catalog facts are shown below. Compatibility and store policies are not verified.',
};
type Component = {
  id: string;
  component: string;
  [key: string]: string | boolean | string[] | { event: { name: string } };
};

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
        image.productId !== focus.productId ||
        referenced.has(child)
      )
        throw new Error('invalid_image');
      referenced.add(child);
    }
    if (referenced.size !== nodes.size) throw new Error('unreachable');
    const products = new Map(catalog.map(item => [item.id, item]));
    const fact = (key: number) => {
      const item = products.get(key);
      if (!item) throw new Error('unknown_product');
      return item;
    };
    const price = (item: CatalogItem) =>
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
      }).format(item.price);
    const components = plan.components.map((node): Component => {
      if (node.component === 'ProductRail')
        return {
          id: node.id,
          component: node.component,
          controls: [],
          entries: node.entries,
          status: LIMITATIONS[plan.answer],
          paging: '',
          previousDisabled: true,
          nextDisabled: true,
          retryVisible: false,
          previous: { event: { name: 'previous' } },
          next: { event: { name: 'next' } },
          retry: { event: { name: 'retry' } },
        };
      if (node.component === 'ProductFocus') {
        const item = node.productId === null ? null : fact(node.productId);
        return {
          id: node.id,
          component: node.component,
          title: 'Catalog guidance',
          description: LIMITATIONS[plan.answer],
          selectedTitle: item?.name ?? '',
          selectedDescription: item?.description ?? '',
          active: item !== null,
          ready: item !== null,
          price: item ? price(item) : '',
          sku: item?.sku ?? '',
          compatibility: item?.fit ?? LIMITATIONS.fit_unknown,
          images: node.images,
          retryVisible: false,
          retry: { event: { name: 'retry-product' } },
        };
      }
      const item = fact(node.productId);
      if (node.component === 'DetailImage')
        return {
          id: node.id,
          component: node.component,
          src: safeImage(item.image),
          name: item.name,
        };
      return {
        id: node.id,
        component: node.component,
        name: item.name,
        description: item.description,
        price: price(item),
        image: safeImage(item.image),
        href: `/products/${item.id}`,
      };
    });
    const messages = [
      {
        version: 'v0.9.1' as const,
        updateComponents: { surfaceId: 'storefront', components },
      },
    ];
    if (bytes(JSON.stringify(messages)) > MAX_BYTES)
      throw new Error('oversized_batch');
    return {
      catalogId: CATALOG_ID,
      messages,
      limitations: [
        LIMITATIONS[plan.answer],
        LIMITATIONS.fit_unknown,
        LIMITATIONS.policy_unknown,
      ],
    };
  } catch {
    throw new ShoppingFailure('invalid_output');
  }
}
