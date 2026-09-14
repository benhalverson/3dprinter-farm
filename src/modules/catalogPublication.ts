import { and, eq, exists, isNull, notExists, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { z } from 'zod';
import {
  squareCatalogMappings as mappings,
  squareCatalogOperations as operations,
  productsTable,
} from '../db/schema';
import type { WorkerEnv } from '../factory';
import {
  isSquareFailure,
  type SquareConfig,
  type SquareItem,
  squareClient,
  squareConfig,
  squareFailure,
} from '../lib/square';
import type { Bindings } from '../types';

export function priceToCents(value: number | null | undefined) {
  return value == null ? value : Math.round(value * 100);
}
export function productPrices<
  T extends { inPersonPrice?: number | null; squareRevision?: number },
>(product: T) {
  const { squareRevision: _revision, ...fields } = product;
  return {
    ...fields,
    inPersonPrice:
      product.inPersonPrice == null ? null : product.inPersonPrice / 100,
  };
}
const publicationFailureSchema = z.object({
  kind: z.literal('catalog_publication_failure'),
  code: z.string(),
  status: z.union([
    z.literal(400),
    z.literal(404),
    z.literal(409),
    z.literal(502),
    z.literal(503),
  ]),
});
type PublicationFailure = z.infer<typeof publicationFailureSchema>;
function publicationFailure(
  code: string,
  status: PublicationFailure['status'],
): PublicationFailure {
  return { kind: 'catalog_publication_failure', code, status };
}
export function isPublicationFailure(
  value: unknown,
): value is PublicationFailure {
  return publicationFailureSchema.safeParse(value).success;
}
type Catalog = typeof productsTable.$inferSelect;
type Mapping = typeof mappings.$inferSelect;
type Operation = typeof operations.$inferSelect;
type Database = WorkerEnv['Variables']['db'];
const publicationSnapshotSchema = z.object({
  name: z.string(),
  description: z.string(),
  sku: z.string().nullable(),
  material: z.string(),
  color: z.string().nullable(),
  cents: z.number().int().safe().nullable(),
});

/** Included in the mutation itself, so publication cannot race a price clear or deletion. */
function safelyUnpublished(db: Database) {
  return notExists(
    db
      .select({ id: mappings.id })
      .from(mappings)
      .where(
        and(
          eq(mappings.productId, productsTable.id),
          or(
            eq(mappings.published, 1),
            exists(
              db
                .select({ id: operations.id })
                .from(operations)
                .where(
                  and(
                    eq(operations.mappingId, mappings.id),
                    eq(operations.state, 'pending'),
                  ),
                ),
            ),
          ),
        ),
      ),
  );
}

export async function saveCatalogItem(
  db: Database,
  current: Catalog,
  changes: Partial<typeof productsTable.$inferInsert>,
) {
  const saved = await db
    .update(productsTable)
    .set({ ...changes, squareRevision: current.squareRevision + 1 })
    .where(
      and(
        eq(productsTable.id, current.id),
        eq(productsTable.squareRevision, current.squareRevision),
        changes.inPersonPrice === null ? safelyUnpublished(db) : undefined,
      ),
    )
    .returning({ id: productsTable.id });
  if (!saved.length)
    throw publicationFailure('catalog_changed_or_unpublication_required', 409);
}

export async function deleteCatalogItem(db: Database, id: number) {
  const deleted = await db
    .delete(productsTable)
    .where(and(eq(productsTable.id, id), safelyUnpublished(db)))
    .returning({ id: productsTable.id });
  if (deleted.length) return;
  const item = await db
    .select({ id: productsTable.id })
    .from(productsTable)
    .where(eq(productsTable.id, id))
    .get();
  throw publicationFailure(
    item ? 'square_unpublication_required' : 'catalog_item_not_found',
    item ? 409 : 404,
  );
}
function snapshot(item: Catalog) {
  return JSON.stringify({
    name: item.name,
    description: item.description,
    sku: item.skuNumber,
    material: item.filamentType,
    color: item.color,
    cents: item.inPersonPrice,
  });
}
function assertMapping(mapping: Mapping, config: SquareConfig) {
  if (
    mapping.environment !== config.SQUARE_ENVIRONMENT ||
    mapping.merchantId !== config.SQUARE_MERCHANT_ID ||
    mapping.locationId !== config.SQUARE_LOCATION_ID
  )
    throw publicationFailure('square_mapping_configuration_mismatch', 409);
}
function publicationPayload(
  item: Catalog,
  mapping: Mapping,
  remote: SquareItem | undefined,
  kind: Operation['kind'],
  key: string,
) {
  const itemId = mapping.itemId ?? '#item';
  const variationId = mapping.variationId ?? '#in-person';
  const existing = remote?.item_data.variations.find(v => v.id === variationId);
  if (
    remote &&
    (!existing || existing.item_variation_data.item_id !== itemId)
  ) {
    throw squareFailure('square_mapping_mismatch');
  }
  if (kind === 'unpublish') {
    if (!remote) throw squareFailure('square_mapping_mismatch');
    return JSON.stringify({
      idempotency_key: key,
      object: {
        ...remote,
        item_data: { ...remote.item_data, is_archived: true },
      },
    });
  }
  const location = {
    present_at_all_locations: false,
    present_at_location_ids: [mapping.locationId],
    absent_at_location_ids: [],
  };
  const variation = {
    ...existing,
    id: variationId,
    type: 'ITEM_VARIATION',
    ...location,
    item_variation_data: {
      ...existing?.item_variation_data,
      item_id: itemId,
      name: `In-Person · ${item.filamentType} · ${item.color ?? ''}`,
      sku: item.skuNumber ?? '',
      pricing_type: 'FIXED_PRICING',
      price_money: { amount: item.inPersonPrice, currency: 'USD' },
      track_inventory: false,
      // A location override must not supersede the authoritative price or enable inventory.
      location_overrides: [
        ...(existing?.item_variation_data.location_overrides ?? []).filter(
          override => override.location_id !== mapping.locationId,
        ),
        {
          ...existing?.item_variation_data.location_overrides?.find(
            override => override.location_id === mapping.locationId,
          ),
          location_id: mapping.locationId,
          price_money: undefined,
          pricing_type: undefined,
          track_inventory: false,
        },
      ],
    },
  };
  return JSON.stringify({
    idempotency_key: key,
    object: {
      ...remote,
      id: itemId,
      type: 'ITEM',
      ...location,
      item_data: {
        ...remote?.item_data,
        name: item.name,
        description: item.description,
        description_html: undefined,
        description_plaintext: undefined,
        is_archived: false,
        variations: remote
          ? remote.item_data.variations.map(v =>
              v.id === variationId ? variation : v,
            )
          : [variation],
      },
    },
  });
}

/** One D1-owned publication boundary. Saves never invoke this module's Square operations. */
export function catalogPublication(env: Bindings) {
  const db = drizzle(env.DB);
  const catalog = (id: number) =>
    db.select().from(productsTable).where(eq(productsTable.id, id)).get();
  const mappingFor = (id: number) =>
    db.select().from(mappings).where(eq(mappings.productId, id)).get();
  const pendingFor = (id: string) =>
    db
      .select()
      .from(operations)
      .where(and(eq(operations.mappingId, id), eq(operations.state, 'pending')))
      .get();
  const unresolved = (id: string) =>
    exists(
      db
        .select({ id: operations.id })
        .from(operations)
        .where(and(eq(operations.id, id), eq(operations.state, 'pending'))),
    );
  async function status(id: number) {
    const item = await catalog(id);
    if (!item) throw publicationFailure('catalog_item_not_found', 404);
    const mapping = await mappingFor(id);
    const pending = mapping ? await pendingFor(mapping.id) : null;
    return {
      id,
      price: item.price,
      inPersonPrice:
        item.inPersonPrice == null ? null : item.inPersonPrice / 100,
      status: !mapping?.published
        ? 'unpublished'
        : mapping.publishedSnapshot === snapshot(item)
          ? 'published'
          : 'needs_update',
      mapping: mapping
        ? {
            environment: mapping.environment,
            merchantId: mapping.merchantId,
            locationId: mapping.locationId,
            itemId: mapping.itemId,
            variationId: mapping.variationId,
          }
        : null,
      pendingOperation: pending
        ? { id: pending.id, kind: pending.kind, createdAt: pending.createdAt }
        : null,
      error: pending?.error ?? mapping?.error ?? null,
    };
  }
  async function operate(id: number, kind: Operation['kind']) {
    const item = await catalog(id);
    if (!item) throw publicationFailure('catalog_item_not_found', 404);
    let mapping = await mappingFor(id);
    let config: SquareConfig;
    try {
      config = squareConfig(env);
    } catch {
      throw publicationFailure('square_configuration_required', 503);
    }
    if (mapping) assertMapping(mapping, config);
    if (!mapping && kind === 'unpublish') return status(id);
    if (!mapping) {
      await db
        .insert(mappings)
        .select(
          db
            .select({
              id: sql<string>`${crypto.randomUUID()}`,
              productId: productsTable.id,
              catalogId: productsTable.id,
              environment: sql<
                Mapping['environment']
              >`${config.SQUARE_ENVIRONMENT}`,
              merchantId: sql<string>`${config.SQUARE_MERCHANT_ID}`,
              locationId: sql<string>`${config.SQUARE_LOCATION_ID}`,
              itemId: sql<null>`${null}`,
              variationId: sql<null>`${null}`,
              published: sql<number>`${0}`,
              publishedSnapshot: sql<null>`${null}`,
              generation: sql<number>`${0}`,
              error: sql<null>`${null}`,
            })
            .from(productsTable)
            .where(eq(productsTable.id, id)),
        )
        .onConflictDoNothing({ target: mappings.productId })
        .run();
      mapping = await mappingFor(id);
      if (!mapping) throw publicationFailure('catalog_item_not_found', 404);
      assertMapping(mapping, config);
    }
    const client = squareClient(config);
    let operation = await pendingFor(mapping.id);
    let firstAttempt = false;
    try {
      await client.validateLocation();
      if (!operation) {
        if (kind === 'unpublish' && !mapping.published) return status(id);
        if (kind === 'publish' && (!item.inPersonPrice || !item.name.trim())) {
          throw publicationFailure(
            'valid_in_person_price_and_name_required',
            400,
          );
        }
        const remote = mapping.itemId
          ? await client.retrieve(mapping.itemId)
          : undefined;
        const key = crypto.randomUUID();
        const payload = publicationPayload(item, mapping, remote, kind, key);
        // A single statement arbitrates concurrent preparations, edits, deletion, and completed operations.
        const [reserved] = await db
          .insert(operations)
          .select(
            db
              .select({
                id: sql<string>`${key}`,
                mappingId: mappings.id,
                kind: sql<Operation['kind']>`${kind}`,
                payload: sql<string>`${payload}`,
                snapshot: sql<string>`${snapshot(item)}`,
                state: sql<Operation['state']>`${'pending'}`,
                error: sql<null>`${null}`,
                createdAt: sql<string>`${new Date().toISOString()}`,
                generation: mappings.generation,
              })
              .from(mappings)
              .innerJoin(
                productsTable,
                eq(productsTable.id, mappings.productId),
              )
              .where(
                and(
                  eq(mappings.id, mapping.id),
                  eq(mappings.generation, mapping.generation),
                  eq(productsTable.squareRevision, item.squareRevision),
                  notExists(
                    db
                      .select({ id: operations.id })
                      .from(operations)
                      .where(
                        and(
                          eq(operations.mappingId, mappings.id),
                          eq(operations.state, 'pending'),
                        ),
                      ),
                  ),
                ),
              ),
          )
          .returning();
        firstAttempt = reserved !== undefined;
        operation = reserved ?? (await pendingFor(mapping.id));
        if (!operation) throw publicationFailure('catalog_changed_retry', 409);
      }
      if (!firstAttempt) {
        // A replay can overlap the original request. Mark that uncertainty before dispatch,
        // so a late first-attempt rejection cannot retire an operation a replay may have applied.
        const replay = await db
          .update(operations)
          .set({ error: 'square_outcome_unknown' })
          .where(
            and(
              eq(operations.id, operation.id),
              eq(operations.state, 'pending'),
            ),
          )
          .returning({ id: operations.id });
        if (!replay.length) return status(id);
      }
      const result = await client.upsert(operation.payload);
      const target = publicationSnapshotSchema.parse(
        JSON.parse(operation.snapshot),
      );
      const variation = mapping.variationId
        ? result.item_data.variations.find(v => v.id === mapping.variationId)
        : result.item_data.variations.length === 1
          ? result.item_data.variations[0]
          : undefined;
      if (
        !variation ||
        variation.is_deleted ||
        variation.version === undefined ||
        result.id.startsWith('#') ||
        variation.id.startsWith('#') ||
        variation.item_variation_data.item_id !== result.id ||
        (mapping.itemId && result.id !== mapping.itemId) ||
        result.item_data.is_archived !== (operation.kind === 'unpublish')
      ) {
        throw squareFailure('square_mapping_mismatch', true);
      }
      if (
        operation.kind === 'publish' &&
        (variation.item_variation_data.pricing_type !== 'FIXED_PRICING' ||
          variation.item_variation_data.price_money?.currency !== 'USD' ||
          variation.item_variation_data.price_money?.amount !== target.cents ||
          result.item_data.name !== target.name ||
          (result.item_data.description ?? '') !== target.description ||
          (variation.item_variation_data.sku ?? '') !== (target.sku ?? '') ||
          variation.item_variation_data.name !==
            `In-Person · ${target.material} · ${target.color ?? ''}`)
      ) {
        throw squareFailure('square_publication_response_mismatch', true);
      }
      // Compare the operation state inside the transaction: a late replay cannot overwrite a newer publication.
      await db.batch([
        db
          .update(mappings)
          .set({
            itemId: result.id,
            variationId: variation.id,
            published: operation.kind === 'publish' ? 1 : 0,
            publishedSnapshot: operation.snapshot,
            generation: operation.generation + 1,
            error: null,
          })
          .where(and(eq(mappings.id, mapping.id), unresolved(operation.id))),
        db
          .update(operations)
          .set({ state: 'succeeded', error: null })
          .where(
            and(
              eq(operations.id, operation.id),
              eq(operations.state, 'pending'),
            ),
          ),
      ]);
    } catch (error) {
      if (isPublicationFailure(error)) throw error;
      const code = isSquareFailure(error)
        ? error.code
        : 'square_outcome_unknown';
      // Once uncertain, a later rejection cannot prove the earlier request had no effect.
      const definite =
        operation && firstAttempt && isSquareFailure(error) && !error.uncertain;
      if (operation) {
        const firstRejection = and(
          eq(operations.id, definite ? operation.id : ''),
          eq(operations.state, 'pending'),
          isNull(operations.error),
        );
        await db.batch([
          db
            .update(mappings)
            .set({ error: code, generation: operation.generation + 1 })
            .where(
              and(
                eq(mappings.id, mapping.id),
                exists(
                  db
                    .select({ id: operations.id })
                    .from(operations)
                    .where(firstRejection),
                ),
              ),
            ),
          db
            .update(operations)
            .set({ error: code, state: 'failed' })
            .where(firstRejection),
          db
            .update(mappings)
            .set({
              error: code,
            })
            .where(and(eq(mappings.id, mapping.id), unresolved(operation.id))),
          db
            .update(operations)
            .set({ error: code })
            .where(
              and(
                eq(operations.id, operation.id),
                eq(operations.state, 'pending'),
              ),
            ),
        ]);
      } else {
        await db
          .update(mappings)
          .set({ error: code })
          .where(
            and(
              eq(mappings.id, mapping.id),
              eq(mappings.generation, mapping.generation),
            ),
          )
          .run();
      }
      throw publicationFailure(code, 502);
    }
    return status(id);
  }
  return {
    status,
    publish: (id: number) => operate(id, 'publish'),
    unpublish: (id: number) => operate(id, 'unpublish'),
  };
}
