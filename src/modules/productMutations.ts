import { and, desc, eq, exists, inArray, isNull, notExists } from 'drizzle-orm';
import {
  categoryTable,
  squareCatalogMappings as mappings,
  productMutationOperations as operations,
  productAssets,
  productDrafts,
  productsTable,
  productsToCategories,
  squareCatalogOperations as publications,
} from '../db/schema';
import type { WorkerEnv } from '../factory';
import {
  isSquareFailure,
  type SquareItem,
  squareClient,
  squareConfig,
  squareFailure,
} from '../lib/square';
import type { Bindings } from '../types';
import { priceToCents } from './catalogPublication';
import {
  cleanupAsset,
  readAsset,
  releaseCatalogOperationAssets,
  reserveAssetAttempt,
} from './productAssets';
import {
  type ProductMutationRequest,
  productMutationResponseSchema,
} from './productMutationContracts';
import { readCurrentPreparation } from './productPreparation';
import type {
  PreparedSnapshot,
  ProductPreparation,
} from './productPreparationContracts';

type Database = WorkerEnv['Variables']['db'];
type Operation = typeof operations.$inferSelect;
export class ProductMutationError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}
/** Limits public recovery evidence to identities, state, and sanitized codes. */
export function mutationResponse(operation: Operation) {
  return productMutationResponseSchema.parse({
    id: operation.id,
    draftId: operation.draftId,
    preparationId: operation.preparationId,
    action: operation.action,
    state: operation.state,
    productId: operation.productId,
    error: operation.error,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    cleanup: operation.cleanup ?? [],
    retryable: [
      'pending',
      'item_confirmed',
      'square_confirmed',
      'repair_required',
    ].includes(operation.state),
  });
}
/** Reads only operations belonging to the authenticated draft owner. */
export async function readProductMutation(
  db: Database,
  ownerId: string,
  draftId: string,
  operationId?: string,
) {
  const operation = await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.ownerId, ownerId),
        eq(operations.draftId, draftId),
        ...(operationId ? [eq(operations.id, operationId)] : []),
      ),
    )
    .orderBy(desc(operations.createdAt))
    .get();
  if (
    operation?.state === 'succeeded' &&
    operation.action === 'create' &&
    operation.productId === null
  ) {
    const product = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.catalogMutationId, operation.id))
      .get();
    if (product) operation.productId = product.id;
  }
  return operation;
}
/** Builds a Square item while retaining fields and variations outside our mapping. */
function squarePayload(
  preparation: ProductPreparation,
  action: Operation['action'],
  locationId: string,
  key: string,
  sku: string,
  remote?: SquareItem,
  variationId?: string | null,
) {
  const snapshot = preparation.snapshot;
  if (!snapshot)
    throw new ProductMutationError(409, 'prepared_snapshot_required');
  if (action === 'delete') {
    if (!remote) throw new ProductMutationError(409, 'square_mapping_required');
    return JSON.stringify({
      idempotency_key: key,
      object: {
        ...remote,
        item_data: { ...remote.item_data, is_archived: true },
      },
    });
  }
  const existing = remote?.item_data.variations.find(
    item => item.id === variationId,
  );
  if (
    remote &&
    (!existing || existing.item_variation_data.item_id !== remote.id)
  )
    throw new ProductMutationError(409, 'square_mapping_mismatch');
  const itemId = remote?.id ?? '#item';
  const location = {
    present_at_all_locations: false,
    present_at_location_ids: [locationId],
    absent_at_location_ids: [],
  };
  const variation = {
    ...existing,
    id: variationId ?? '#in-person',
    type: 'ITEM_VARIATION',
    ...location,
    item_variation_data: {
      ...existing?.item_variation_data,
      item_id: itemId,
      name: `In-Person · ${snapshot.filamentType} · ${snapshot.color}`,
      sku,
      pricing_type: 'FIXED_PRICING',
      price_money: {
        amount: priceToCents(preparation.pricing.inPersonPrice ?? 0),
        currency: 'USD',
      },
      track_inventory: false,
      location_overrides: [
        ...(existing?.item_variation_data.location_overrides ?? []).filter(
          value => value.location_id !== locationId,
        ),
        {
          ...existing?.item_variation_data.location_overrides?.find(
            value => value.location_id === locationId,
          ),
          location_id: locationId,
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
        name: snapshot.name,
        description: snapshot.description,
        description_html: undefined,
        description_plaintext: undefined,
        is_archived: false,
        variations: remote
          ? remote.item_data.variations.map(item =>
              item.id === variationId ? variation : item,
            )
          : [variation],
      },
    },
  });
}
/** Confirms exact owned fields before treating any provider response as success. */
function confirmedResult(operation: Operation, result: SquareItem) {
  const request = JSON.parse(operation.payload) as { object: SquareItem };
  const expected = request.object;
  const expectedVariation = expected.item_data.variations.find(
    item =>
      item.id ===
      (operation.action === 'create'
        ? '#in-person'
        : operation.resultVariationId),
  );
  const variation =
    operation.action === 'create' && result.item_data.variations.length === 1
      ? result.item_data.variations[0]
      : result.item_data.variations.find(
          item => item.id === operation.resultVariationId,
        );
  if (
    result.id.startsWith('#') ||
    result.is_deleted ||
    !variation ||
    variation.id.startsWith('#') ||
    variation.is_deleted ||
    variation.version === undefined ||
    variation.item_variation_data.item_id !== result.id ||
    (operation.action !== 'create' && result.id !== expected.id) ||
    result.item_data.is_archived !== (operation.action === 'delete')
  )
    throw squareFailure('square_publication_response_mismatch', true);
  if (
    operation.action !== 'delete' &&
    (!expectedVariation ||
      result.item_data.name !== expected.item_data.name ||
      (result.item_data.description ?? '') !== expected.item_data.description ||
      variation.item_variation_data.name !==
        expectedVariation.item_variation_data.name ||
      variation.item_variation_data.sku !==
        expectedVariation.item_variation_data.sku ||
      variation.item_variation_data.price_money?.amount !==
        operation.localInPersonPrice ||
      variation.item_variation_data.price_money?.currency !== 'USD' ||
      variation.item_variation_data.pricing_type !== 'FIXED_PRICING' ||
      variation.item_variation_data.track_inventory !== false ||
      result.present_at_all_locations !== false ||
      !Array.isArray(result.present_at_location_ids) ||
      !result.present_at_location_ids.includes(operation.locationId) ||
      variation.present_at_all_locations !== false ||
      !Array.isArray(variation.present_at_location_ids) ||
      !variation.present_at_location_ids.includes(operation.locationId) ||
      (Array.isArray(result.absent_at_location_ids) &&
        result.absent_at_location_ids.includes(operation.locationId)) ||
      (Array.isArray(variation.absent_at_location_ids) &&
        variation.absent_at_location_ids.includes(operation.locationId)) ||
      variation.item_variation_data.location_overrides?.some(
        override =>
          override.location_id === operation.locationId &&
          (override.price_money !== undefined ||
            override.pricing_type !== undefined ||
            override.track_inventory !== false),
      ))
  )
    throw squareFailure('square_publication_response_mismatch', true);
  return variation;
}
/** Requires the persisted environment, seller, and location on every recovery run. */
function configured(env: Bindings, operation?: Operation) {
  let config: ReturnType<typeof squareConfig>;
  try {
    config = squareConfig(env);
  } catch {
    throw new ProductMutationError(503, 'square_configuration_required');
  }
  if (
    operation &&
    (operation.environment !== config.SQUARE_ENVIRONMENT ||
      operation.merchantId !== config.SQUARE_MERCHANT_ID ||
      operation.locationId !== config.SQUARE_LOCATION_ID)
  )
    throw new ProductMutationError(
      409,
      'square_mapping_configuration_mismatch',
    );
  return config;
}
/** Rechecks identities independently of draft history before local completion. */
async function completionBindings(db: Database, snapshot: PreparedSnapshot) {
  for (const category of snapshot.categoryBindings) {
    const row = await db
      .select()
      .from(categoryTable)
      .where(eq(categoryTable.categoryId, category.categoryId))
      .get();
    if (!row || row.categoryName !== category.categoryName) return false;
  }
  for (const id of snapshot.assetIds) {
    const asset = await db
      .select()
      .from(productAssets)
      .where(eq(productAssets.id, id))
      .get();
    if (!asset || asset.status !== 'active') return false;
  }
  return true;
}
/** Accepts only an explicit action bound to a current persisted preparation. */
export async function submitProductMutation(
  db: Database,
  env: Bindings,
  ownerId: string,
  draftId: string,
  input: ProductMutationRequest,
) {
  const existing = await readProductMutation(db, ownerId, draftId);
  if (
    existing &&
    existing.state !== 'failed' &&
    !(
      existing.state === 'succeeded' &&
      existing.action !== 'create' &&
      existing.preparationId !== input.preparationId
    )
  ) {
    if (
      existing.preparationId !== input.preparationId ||
      existing.action !== input.action ||
      existing.draftRevision !== input.expectedRevision
    )
      throw new ProductMutationError(409, 'operation_reconciliation_required');
    return existing;
  }
  const preparation = await readCurrentPreparation(db, ownerId, draftId);
  if (!preparation)
    throw new ProductMutationError(404, 'preparation_not_found');
  if (
    preparation.id !== input.preparationId ||
    preparation.draftRevision !== input.expectedRevision ||
    preparation.status !== 'ready' ||
    !preparation.readiness.ready ||
    !preparation.snapshot
  )
    throw new ProductMutationError(409, 'current_preparation_required');
  const snapshot = preparation.snapshot;
  if (snapshot.action !== input.action)
    throw new ProductMutationError(409, 'prepared_action_mismatch');
  if ((input.action === 'create') !== (snapshot.target.kind === 'new'))
    throw new ProductMutationError(400, 'action_target_mismatch');
  const config = configured(env);
  const product =
    snapshot.target.kind === 'existing'
      ? await db
          .select()
          .from(productsTable)
          .where(eq(productsTable.id, snapshot.target.productId))
          .get()
      : undefined;
  if (
    snapshot.target.kind === 'existing' &&
    (!product || product.squareRevision !== snapshot.productRevision)
  )
    throw new ProductMutationError(409, 'catalog_changed_retry');
  const mapping = product
    ? await db
        .select()
        .from(mappings)
        .where(eq(mappings.productId, product.id))
        .get()
    : undefined;
  if (product && !mapping?.itemId)
    throw new ProductMutationError(409, 'square_mapping_required');
  if (
    mapping &&
    (mapping.environment !== config.SQUARE_ENVIRONMENT ||
      mapping.merchantId !== config.SQUARE_MERCHANT_ID ||
      mapping.locationId !== config.SQUARE_LOCATION_ID)
  )
    throw new ProductMutationError(
      409,
      'square_mapping_configuration_mismatch',
    );
  if (
    mapping &&
    (await db
      .select()
      .from(publications)
      .where(
        and(
          eq(publications.mappingId, mapping.id),
          eq(publications.state, 'pending'),
        ),
      )
      .get())
  )
    throw new ProductMutationError(
      409,
      'square_operation_reconciliation_required',
    );
  const client = squareClient(config);
  await client.validateLocation();
  const remote = mapping?.itemId
    ? await client.retrieve(mapping.itemId)
    : undefined;
  const id = crypto.randomUUID();
  const sku = product?.skuNumber ?? id;
  const payload = squarePayload(
    preparation,
    input.action,
    config.SQUARE_LOCATION_ID,
    id,
    sku,
    remote,
    mapping?.variationId,
  );
  const assets = [];
  for (const binding of snapshot.assetRevisions) {
    const asset = await db
      .select()
      .from(productAssets)
      .where(eq(productAssets.id, binding.id))
      .get();
    if (
      !asset ||
      asset.status !== 'active' ||
      asset.revision !== binding.revision
    )
      throw new ProductMutationError(409, 'prepared_asset_changed');
    assets.push(asset);
  }
  const release = await reserveAssetAttempt(
    db,
    assets,
    'catalog',
    `catalog-attempt:${id}`,
  );
  const heldAssets = [];
  for (const asset of assets) {
    const held = await db
      .select()
      .from(productAssets)
      .where(eq(productAssets.id, asset.id))
      .get();
    if (!held || held.revision !== asset.revision + 1) {
      await release();
      throw new ProductMutationError(409, 'prepared_asset_changed');
    }
    heldAssets.push(held);
  }
  const now = Date.now();
  const publishedSnapshot = JSON.stringify({
    name: snapshot.name,
    description: snapshot.description,
    sku,
    material: snapshot.filamentType,
    color: snapshot.color,
    cents: priceToCents(preparation.pricing.inPersonPrice ?? 0),
  });
  const [candidate] = await db
    .insert(operations)
    .values({
      id,
      ownerId,
      draftId,
      preparationId: preparation.id,
      draftRevision: input.expectedRevision,
      action: input.action,
      state: 'prepared',
      preparation,
      payload,
      environment: config.SQUARE_ENVIRONMENT,
      merchantId: config.SQUARE_MERCHANT_ID,
      locationId: config.SQUARE_LOCATION_ID,
      mappingId: mapping?.id ?? id,
      mappingGeneration: mapping?.generation ?? 0,
      resultItemId: mapping?.itemId ?? null,
      resultVariationId: mapping?.variationId ?? null,
      productId: product?.id ?? null,
      createdAt: now,
      updatedAt: now,
      localName: snapshot.name,
      localDescription: snapshot.description,
      localImage: snapshot.primaryPhotoAssetId
        ? `/catalog/assets/${snapshot.primaryPhotoAssetId}/image`
        : snapshot.image,
      localImageGallery: JSON.stringify(
        snapshot.imageGallery.map(value => value),
      ),
      localStl: snapshot.stl,
      localPrice: preparation.pricing.onlinePrice ?? product?.price ?? 0,
      localMarkupPercentage: preparation.pricing.markupPercentage,
      localFilamentType: snapshot.filamentType,
      localSkuNumber: sku,
      localColor: snapshot.color,
      localInPersonPrice: priceToCents(preparation.pricing.inPersonPrice ?? 0),
      localPublicFileServiceId: snapshot.publicFileServiceId,
      localCategoryId: snapshot.categoryIds[0] ?? null,
      localSquareRevision: (snapshot.productRevision ?? -1) + 1,
      localPublishedSnapshot: publishedSnapshot,
      localCreatedAt: new Date(now).toISOString(),
    })
    .onConflictDoNothing()
    .returning();
  if (!candidate) {
    await release();
    const current = await readProductMutation(db, ownerId, draftId);
    if (
      current &&
      current.preparationId === preparation.id &&
      current.action === input.action
    )
      return current;
    throw new ProductMutationError(409, 'operation_reconciliation_required');
  }
  const [activated] = await db
    .update(operations)
    .set({ state: 'pending' })
    .where(
      and(
        eq(operations.id, id),
        eq(operations.state, 'prepared'),
        exists(
          db
            .select({ id: productDrafts.id })
            .from(productDrafts)
            .where(
              and(
                eq(productDrafts.id, draftId),
                eq(productDrafts.ownerId, ownerId),
                eq(productDrafts.revision, input.expectedRevision),
                eq(productDrafts.status, 'active'),
              ),
            ),
        ),
        ...(product
          ? [
              exists(
                db
                  .select({ id: productsTable.id })
                  .from(productsTable)
                  .where(
                    and(
                      eq(productsTable.id, product.id),
                      eq(
                        productsTable.squareRevision,
                        snapshot.productRevision ?? -1,
                      ),
                    ),
                  ),
              ),
            ]
          : []),
        ...(mapping
          ? [
              exists(
                db
                  .select({ id: mappings.id })
                  .from(mappings)
                  .where(
                    and(
                      eq(mappings.id, mapping.id),
                      eq(mappings.generation, mapping.generation),
                    ),
                  ),
              ),
              notExists(
                db
                  .select({ id: publications.id })
                  .from(publications)
                  .where(
                    and(
                      eq(publications.mappingId, mapping.id),
                      eq(publications.state, 'pending'),
                    ),
                  ),
              ),
            ]
          : []),
        ...heldAssets.map(asset =>
          exists(
            db
              .select({ id: productAssets.id })
              .from(productAssets)
              .where(
                and(
                  eq(productAssets.id, asset.id),
                  eq(productAssets.revision, asset.revision),
                  eq(productAssets.status, 'active'),
                ),
              ),
          ),
        ),
        ...snapshot.categoryBindings.map(category =>
          exists(
            db
              .select({ id: categoryTable.categoryId })
              .from(categoryTable)
              .where(
                and(
                  eq(categoryTable.categoryId, category.categoryId),
                  eq(categoryTable.categoryName, category.categoryName),
                ),
              ),
          ),
        ),
      ),
    )
    .returning();
  if (!activated) {
    await db
      .update(operations)
      .set({
        state: 'failed',
        error: 'preparation_changed',
        updatedAt: Date.now(),
      })
      .where(and(eq(operations.id, id), eq(operations.state, 'prepared')));
    await release();
    throw new ProductMutationError(409, 'current_preparation_required');
  }
  return reconcileProductMutation(db, env, ownerId, draftId, id, true);
}
/** Commits only a confirmed immutable snapshot; concurrent local edits become visible repair work. */
async function completeLocally(db: Database, operation: Operation) {
  const snapshot = operation.preparation.snapshot;
  if (!snapshot)
    throw new ProductMutationError(409, 'prepared_snapshot_required');
  if (!(await completionBindings(db, snapshot)))
    throw new ProductMutationError(409, 'completion_binding_changed');
  const token = crypto.randomUUID();
  const eligible = and(
    eq(operations.id, operation.id),
    inArray(operations.state, ['square_confirmed', 'repair_required']),
  );
  const tokenGuard = and(
    eq(operations.id, operation.id),
    eq(operations.completionToken, token),
    inArray(operations.state, ['square_confirmed', 'repair_required']),
  );
  const confirmed = exists(
    db.select({ id: operations.id }).from(operations).where(tokenGuard),
  );
  const targetGuard = and(
    eq(productsTable.id, operation.productId ?? -1),
    eq(productsTable.squareRevision, snapshot.productRevision ?? -1),
  );
  const currentBindings = [
    ...snapshot.categoryBindings.map(category =>
      exists(
        db
          .select({ id: categoryTable.categoryId })
          .from(categoryTable)
          .where(
            and(
              eq(categoryTable.categoryId, category.categoryId),
              eq(categoryTable.categoryName, category.categoryName),
            ),
          ),
      ),
    ),
    ...snapshot.assetIds.map(id =>
      exists(
        db
          .select({ id: productAssets.id })
          .from(productAssets)
          .where(
            and(eq(productAssets.id, id), eq(productAssets.status, 'active')),
          ),
      ),
    ),
  ];
  const activate = db
    .update(operations)
    .set({ completionToken: token, error: null })
    .where(
      and(
        eligible,
        ...currentBindings,
        ...(operation.action === 'create'
          ? []
          : [
              exists(
                db
                  .select({ id: productsTable.id })
                  .from(productsTable)
                  .where(targetGuard),
              ),
            ]),
        ...(operation.action === 'create'
          ? []
          : [
              exists(
                db
                  .select({ id: mappings.id })
                  .from(mappings)
                  .where(
                    and(
                      eq(mappings.id, operation.mappingId ?? ''),
                      eq(
                        mappings.generation,
                        operation.mappingGeneration ?? -1,
                      ),
                    ),
                  ),
              ),
            ]),
      ),
    );
  const productForCompletion =
    operation.action === 'create'
      ? eq(productsTable.catalogMutationId, operation.id)
      : and(
          eq(productsTable.id, operation.productId ?? -1),
          eq(productsTable.squareRevision, operation.localSquareRevision),
          eq(productsTable.catalogMutationId, operation.id),
        );
  const productExists = exists(
    db
      .select({ id: productsTable.id })
      .from(productsTable)
      .where(productForCompletion),
  );
  if (operation.action === 'create') {
    const insert = db
      .insert(productsTable)
      .select(
        db
          .select({
            id: operations.localId,
            name: operations.localName,
            description: operations.localDescription,
            image: operations.localImage,
            imageGallery: operations.localImageGallery,
            stl: operations.localStl,
            price: operations.localPrice,
            markupPercentage: operations.localMarkupPercentage,
            filamentType: operations.localFilamentType,
            skuNumber: operations.localSkuNumber,
            color: operations.localColor,
            inPersonPrice: operations.localInPersonPrice,
            squareRevision: operations.localSquareRevision,
            catalogMutationId: operations.id,
            publicFileServiceId: operations.localPublicFileServiceId,
            categoryId: operations.localCategoryId,
          })
          .from(operations)
          .where(tokenGuard),
      )
      .onConflictDoNothing({ target: productsTable.catalogMutationId });
    const mappingInsert = db
      .insert(mappings)
      .select(
        db
          .select({
            id: operations.mappingId,
            productId: productsTable.id,
            catalogId: productsTable.id,
            environment: operations.environment,
            merchantId: operations.merchantId,
            locationId: operations.locationId,
            itemId: operations.resultItemId,
            variationId: operations.resultVariationId,
            published: operations.localPublished,
            publishedSnapshot: operations.localPublishedSnapshot,
            generation: operations.localSquareRevision,
            error: operations.localError,
          })
          .from(operations)
          .innerJoin(
            productsTable,
            eq(productsTable.catalogMutationId, operations.id),
          )
          .where(tokenGuard),
      )
      .onConflictDoNothing({ target: mappings.productId });
    await db.batch([
      activate,
      insert,
      mappingInsert,
      ...snapshot.categoryIds.map(categoryId =>
        db
          .insert(productsToCategories)
          .select(
            db
              .select({
                productId: productsTable.id,
                categoryId: categoryTable.categoryId,
                orderIndex: operations.localNull,
                createdAt: operations.localCreatedAt,
              })
              .from(operations)
              .innerJoin(
                productsTable,
                eq(productsTable.catalogMutationId, operations.id),
              )
              .innerJoin(
                categoryTable,
                eq(categoryTable.categoryId, categoryId),
              )
              .where(tokenGuard),
          )
          .onConflictDoNothing(),
      ),
      db
        .update(operations)
        .set({ state: 'succeeded', updatedAt: Date.now(), error: null })
        .where(and(tokenGuard, productExists)),
    ]);
  } else if (operation.action === 'update') {
    await db.batch([
      activate,
      db
        .update(productsTable)
        .set({
          name: operation.localName,
          description: operation.localDescription,
          image: operation.localImage,
          imageGallery: operation.localImageGallery,
          stl: operation.localStl,
          price: operation.localPrice,
          markupPercentage: operation.localMarkupPercentage,
          filamentType: operation.localFilamentType,
          color: operation.localColor,
          inPersonPrice: operation.localInPersonPrice,
          publicFileServiceId: operation.localPublicFileServiceId,
          categoryId: operation.localCategoryId,
          squareRevision: operation.localSquareRevision,
          catalogMutationId: operation.id,
        })
        .where(and(targetGuard, confirmed)),
      db
        .update(mappings)
        .set({
          published: 1,
          publishedSnapshot: operation.localPublishedSnapshot,
          generation: (operation.mappingGeneration ?? -1) + 1,
          error: null,
        })
        .where(
          and(
            eq(mappings.id, operation.mappingId ?? ''),
            confirmed,
            productExists,
          ),
        ),
      db
        .delete(productsToCategories)
        .where(
          and(
            eq(productsToCategories.productId, operation.productId ?? -1),
            confirmed,
            productExists,
          ),
        ),
      ...snapshot.categoryIds.map(categoryId =>
        db
          .insert(productsToCategories)
          .select(
            db
              .select({
                productId: productsTable.id,
                categoryId: categoryTable.categoryId,
                orderIndex: operations.localNull,
                createdAt: operations.localCreatedAt,
              })
              .from(operations)
              .innerJoin(
                productsTable,
                eq(productsTable.id, operations.productId),
              )
              .innerJoin(
                categoryTable,
                eq(categoryTable.categoryId, categoryId),
              )
              .where(and(tokenGuard, productForCompletion)),
          )
          .onConflictDoNothing(),
      ),
      db
        .update(operations)
        .set({ state: 'succeeded', updatedAt: Date.now(), error: null })
        .where(and(tokenGuard, productExists)),
    ]);
  } else {
    await db.batch([
      activate,
      db
        .update(mappings)
        .set({
          published: 0,
          generation: (operation.mappingGeneration ?? -1) + 1,
          error: null,
        })
        .where(and(eq(mappings.id, operation.mappingId ?? ''), confirmed)),
      db.delete(productsTable).where(and(targetGuard, confirmed)),
      db
        .update(operations)
        .set({ state: 'succeeded', updatedAt: Date.now(), error: null })
        .where(
          and(
            tokenGuard,
            notExists(
              db
                .select({ id: productsTable.id })
                .from(productsTable)
                .where(eq(productsTable.id, operation.productId ?? -1)),
            ),
          ),
        ),
    ]);
  }
  const current = await readProductMutation(
    db,
    operation.ownerId,
    operation.draftId,
    operation.id,
  );
  if (current?.state !== 'succeeded')
    throw new ProductMutationError(409, 'local_completion_conflict');
  if (operation.action === 'create') {
    const product = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.catalogMutationId, operation.id))
      .get();
    if (!product)
      throw new ProductMutationError(409, 'local_completion_conflict');
    await db
      .update(operations)
      .set({ productId: product.id })
      .where(eq(operations.id, operation.id));
    current.productId = product.id;
  }
  return current;
}
/** Resumes the exact saved remote request, then resumes local persistence without republishing. */
export async function reconcileProductMutation(
  db: Database,
  env: Bindings,
  ownerId: string,
  draftId: string,
  operationId: string,
  firstAttempt = false,
) {
  let operation = await readProductMutation(db, ownerId, draftId, operationId);
  if (!operation) throw new ProductMutationError(404, 'operation_not_found');
  if (operation.state === 'succeeded' || operation.state === 'failed')
    return finishAssets(db, env, operation);
  if (operation.state === 'prepared') {
    const [retired] = await db
      .update(operations)
      .set({
        state: 'failed',
        error: 'inert_operation_retired_reprepare',
        updatedAt: Date.now(),
      })
      .where(
        and(eq(operations.id, operation.id), eq(operations.state, 'prepared')),
      )
      .returning();
    if (!retired)
      return await requireProductMutation(db, ownerId, draftId, operationId);
    return finishAssets(db, env, retired);
  }
  const config = configured(env, operation);
  const client = squareClient(config);
  try {
    if (operation.state === 'pending') {
      // Mark overlapping replays before dispatch. A late rejection cannot retire
      // an operation whose earlier request might already have succeeded.
      if (!firstAttempt) {
        const [marked] = await db
          .update(operations)
          .set({
            replayed: 1,
            error: 'square_outcome_unknown',
            updatedAt: Date.now(),
          })
          .where(
            and(
              eq(operations.id, operation.id),
              eq(operations.state, 'pending'),
            ),
          )
          .returning();
        if (!marked)
          return await requireProductMutation(
            db,
            ownerId,
            draftId,
            operationId,
          );
        operation = marked;
      }
      const result = await client.upsert(operation.payload);
      const variation = confirmedResult(operation, result);
      const imagePayload =
        operation.action === 'delete' ||
        !operation.preparation.snapshot?.primaryPhotoAssetId
          ? null
          : JSON.stringify({
              idempotency_key: `${operation.id}:primary-image`,
              object_id: result.id,
              is_primary: true,
              image: {
                id: '#primary-image',
                type: 'IMAGE',
                image_data: { caption: operation.localName },
              },
            });
      await db
        .update(operations)
        .set({
          state: imagePayload ? 'item_confirmed' : 'square_confirmed',
          squareResult: result,
          resultItemId: result.id,
          resultVariationId: variation.id,
          imagePayload,
          error: null,
          updatedAt: Date.now(),
        })
        .where(
          and(eq(operations.id, operation.id), eq(operations.state, 'pending')),
        );
      operation = await requireProductMutation(
        db,
        ownerId,
        draftId,
        operationId,
      );
    }
    if (operation.state === 'item_confirmed') {
      const { decryptPhoto } = await import('./productPhotoBytes');
      const assetId = operation.preparation.snapshot?.primaryPhotoAssetId ?? '';
      const asset = await db
        .select()
        .from(productAssets)
        .where(eq(productAssets.id, assetId))
        .get();
      if (
        !asset ||
        asset.status !== 'active' ||
        !asset.references.includes(`catalog-attempt:${operation.id}`)
      )
        throw new ProductMutationError(409, 'primary_photo_unavailable');
      if (!operation.resultImageId) {
        const stored = await env.PHOTO_BUCKET.get(asset.objectKey);
        if (!stored)
          throw new ProductMutationError(409, 'primary_photo_unavailable');
        const bytes = await decryptPhoto(
          await stored.arrayBuffer(),
          asset.encryptionKey,
          asset.id,
        );
        const image = await client.createImage(
          operation.imagePayload ?? '',
          bytes,
          asset.contentType ?? 'image/png',
        );
        await db
          .update(operations)
          .set({ resultImageId: image.id, updatedAt: Date.now() })
          .where(
            and(
              eq(operations.id, operation.id),
              eq(operations.state, 'item_confirmed'),
              isNull(operations.resultImageId),
            ),
          );
        operation = await requireProductMutation(
          db,
          ownerId,
          draftId,
          operationId,
        );
      }
      const linked = await client.retrieve(operation.resultItemId ?? '');
      const imageIds = linked.item_data.image_ids;
      if (!Array.isArray(imageIds) || imageIds[0] !== operation.resultImageId)
        throw squareFailure('square_publication_response_mismatch', true);
      confirmedResult(operation, linked);
      await db
        .update(operations)
        .set({
          state: 'square_confirmed',
          squareResult: linked,
          error: null,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(operations.id, operation.id),
            eq(operations.state, 'item_confirmed'),
          ),
        );
      operation = await requireProductMutation(
        db,
        ownerId,
        draftId,
        operationId,
      );
    }
    if (
      operation.state === 'square_confirmed' ||
      operation.state === 'repair_required'
    ) {
      try {
        return finishAssets(db, env, await completeLocally(db, operation));
      } catch (error) {
        const code =
          error instanceof ProductMutationError
            ? error.message
            : 'local_completion_failed';
        await db
          .update(operations)
          .set({ state: 'repair_required', error: code, updatedAt: Date.now() })
          .where(
            and(
              eq(operations.id, operation.id),
              inArray(operations.state, [
                'square_confirmed',
                'repair_required',
              ]),
            ),
          );
        return await requireProductMutation(db, ownerId, draftId, operationId);
      }
    }
    return operation;
  } catch (error) {
    if (error instanceof ProductMutationError) {
      await db
        .update(operations)
        .set({ error: error.message, updatedAt: Date.now() })
        .where(
          and(
            eq(operations.id, operation.id),
            inArray(operations.state, ['pending', 'item_confirmed']),
          ),
        );
      return await requireProductMutation(db, ownerId, draftId, operationId);
    }
    const code = isSquareFailure(error) ? error.code : 'square_outcome_unknown';
    // Terminal failure is allowed only for the first request with no overlapping replay.
    if (
      firstAttempt &&
      operation.state === 'pending' &&
      isSquareFailure(error) &&
      !error.uncertain
    ) {
      await db
        .update(operations)
        .set({ state: 'failed', error: code, updatedAt: Date.now() })
        .where(
          and(
            eq(operations.id, operation.id),
            eq(operations.state, 'pending'),
            eq(operations.replayed, 0),
            isNull(operations.error),
          ),
        );
    }
    await db
      .update(operations)
      .set({ error: code, updatedAt: Date.now() })
      .where(
        and(
          eq(operations.id, operation.id),
          inArray(operations.state, ['pending', 'item_confirmed']),
        ),
      );
    return finishAssets(
      db,
      env,
      await requireProductMutation(db, ownerId, draftId, operationId),
    );
  }
}

/** Reclaims only assets with no remaining catalog/order/draft/operation references. */
async function finishAssets(db: Database, env: Bindings, operation: Operation) {
  if (operation.state !== 'succeeded' && operation.state !== 'failed')
    return operation;
  const snapshot = operation.preparation.snapshot;
  if (!snapshot) return operation;
  const unused = snapshot.cleanupAssetIds.filter(
    id => operation.action === 'delete' || !snapshot.assetIds.includes(id),
  );
  const currentCatalog = db
    .select({ id: productsTable.id })
    .from(productsTable)
    .where(
      and(
        eq(productsTable.id, operation.productId ?? -1),
        eq(productsTable.catalogMutationId, operation.id),
      ),
    );
  const referenceAuthority =
    operation.action === 'delete'
      ? notExists(
          db
            .select({ id: productsTable.id })
            .from(productsTable)
            .where(eq(productsTable.id, operation.productId ?? -1)),
        )
      : exists(currentCatalog);
  try {
    if (operation.state === 'succeeded' && operation.action !== 'delete') {
      for (const id of snapshot.assetIds) {
        const asset = await readAsset(db, id);
        if (
          asset &&
          !asset.references.includes(`catalog:${operation.productId}`)
        )
          await db
            .update(productAssets)
            .set({
              references: [
                ...new Set([
                  ...asset.references,
                  `catalog:${operation.productId}`,
                ]),
              ],
              revision: asset.revision + 1,
            })
            .where(
              and(
                eq(productAssets.id, asset.id),
                eq(productAssets.revision, asset.revision),
                eq(productAssets.status, 'active'),
                referenceAuthority,
              ),
            )
            .returning();
      }
    }
    if (operation.state === 'succeeded' && operation.action !== 'create') {
      for (const id of unused) {
        const asset = await readAsset(db, id);
        if (asset?.references.includes(`catalog:${operation.productId}`))
          await db
            .update(productAssets)
            .set({
              references: asset.references.filter(
                reference => reference !== `catalog:${operation.productId}`,
              ),
              revision: asset.revision + 1,
            })
            .where(
              and(
                eq(productAssets.id, asset.id),
                eq(productAssets.revision, asset.revision),
                referenceAuthority,
              ),
            )
            .returning();
      }
    }
    await releaseCatalogOperationAssets(db, operation.id);
    if (operation.state === 'succeeded' && operation.action !== 'create') {
      const cleanup = [];
      for (const assetId of unused)
        cleanup.push({
          id: assetId,
          assetId,
          ...(await cleanupAsset(db, env, assetId)),
        });
      await db
        .update(operations)
        .set({ cleanup, updatedAt: Date.now() })
        .where(
          and(
            eq(operations.id, operation.id),
            eq(operations.state, 'succeeded'),
          ),
        );
      operation.cleanup = cleanup;
    }
  } catch {
    // Local completion is durable even if asset bookkeeping fails. Retry remains
    // explicit and holds remain in place, preventing premature storage deletion.
    if (operation.state === 'succeeded' && operation.action !== 'create') {
      operation.cleanup = unused.map(assetId => ({
        id: assetId,
        assetId,
        status: 'pending',
        reason: 'Asset cleanup unavailable; retry reconciliation',
      }));
      try {
        await db
          .update(operations)
          .set({ cleanup: operation.cleanup })
          .where(eq(operations.id, operation.id));
      } catch {
        /* Retained holds still protect the files. */
      }
    }
  }
  return operation;
}

/** Recovery records cannot disappear silently between dependent phases. */
async function requireProductMutation(
  db: Database,
  ownerId: string,
  draftId: string,
  operationId: string,
) {
  const operation = await readProductMutation(
    db,
    ownerId,
    draftId,
    operationId,
  );
  if (!operation) throw new ProductMutationError(404, 'operation_not_found');
  return operation;
}
