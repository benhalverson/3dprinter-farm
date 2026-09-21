import { asc, eq, like, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { z } from 'zod';
import { productsTable } from '../db/schema';

export const catalogItemSchema = z.object({
  id: z.number().int().positive().safe(),
  name: z.string().max(512),
  description: z.string().max(4096),
  image: z.string(),
  price: z.number().finite().nonnegative(),
  sku: z.string(),
  fit: z.string().nullable(),
});
export type CatalogItem = z.infer<typeof catalogItemSchema>;
export const toolInputSchema = z.discriminatedUnion('name', [
  z
    .object({
      name: z.literal('catalog_list'),
      arguments: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal('catalog_search'),
      arguments: z
        .object({ query: z.string().trim().min(1).max(128) })
        .strict(),
    })
    .strict(),
  z
    .object({
      name: z.literal('catalog_detail'),
      arguments: z.object({ id: z.number().int().positive().safe() }).strict(),
    })
    .strict(),
]);
export type CatalogQuery = z.infer<typeof toolInputSchema>;
export type CatalogReader = (query: CatalogQuery) => Promise<CatalogItem[]>;

export function catalogReader(db: D1Database): CatalogReader {
  return async input => {
    const query = toolInputSchema.parse(input);
    const condition =
      query.name === 'catalog_detail'
        ? eq(productsTable.id, query.arguments.id)
        : query.name === 'catalog_search'
          ? or(
              like(productsTable.name, `%${query.arguments.query}%`),
              like(productsTable.description, `%${query.arguments.query}%`),
            )
          : undefined;
    // Same public visibility as /products and /product/:id. Explicit projection
    // prevents print-file URLs, provider IDs and credentials entering model context.
    const rows = await drizzle(db)
      .select({
        id: productsTable.id,
        name: productsTable.name,
        description: productsTable.description,
        image: productsTable.image,
        price: productsTable.price,
        sku: productsTable.skuNumber,
      })
      .from(productsTable)
      .where(condition)
      .orderBy(asc(productsTable.id))
      .limit(12)
      .all();
    return rows.map(row =>
      catalogItemSchema.parse({
        ...row,
        name: row.name.slice(0, 512),
        description: row.description.slice(0, 4096),
        image: safeImage(row.image),
        sku: row.sku ?? '',
        fit: null,
      }),
    );
  };
}
export function safeImage(value: string | null) {
  if (!value || value.length > 2048) return '';
  try {
    return new URL(value).protocol === 'https:' ? value : '';
  } catch {
    return '';
  }
}
