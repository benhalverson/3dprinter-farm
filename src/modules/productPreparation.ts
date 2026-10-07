import { and, eq, inArray, like, or } from 'drizzle-orm';
import { z } from 'zod';
import { slantV2Url } from '../constants';
import {
  categoryTable,
  productAssets,
  productDrafts,
  productsTable,
  inPersonPriceSchema,
} from '../db/schema';
import type { WorkerEnv } from '../factory';
import { estimateSlant3DFile, getSlant3DFile } from '../lib/slant3d-v2-files';
import type { Bindings } from '../types';
import { calculateMarkupPrice } from '../utils/calculateMarkupPrice';
import { AttachmentError } from './productAssets';
import { attachmentProjection } from './productAttachments';
import { normalizeCategoryName } from './productCategories';
import { readProductDraft, readProductDraftContext } from './productDrafts';
import {
  productPreparationSchema,
  type ProductPreparation,
  type PreparedSnapshot,
} from './productPreparationContracts';

type Database = WorkerEnv['Variables']['db'];
type Draft = typeof productDrafts.$inferSelect;
const filamentsSchema = z.object({
  success: z.literal(true),
  data: z
    .array(
      z.object({
        publicId: z.string().uuid(),
        profile: z.string(),
        color: z.string(),
        hexValue: z.string(),
        provider: z.string(),
        available: z.boolean(),
      }),
    )
    .max(500),
});
const numericAnswer = (value: string | undefined, retained: number | null) =>
  value === undefined
    ? retained
    : /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))
      ? Number(value)
      : null;

/** Build the authoritative source binding independently of saved conversation history. */
async function sources(db: Database, row: Draft) {
  const context = await readProductDraftContext(db, row.target);
  const product =
    row.target.kind === 'existing'
      ? await db
          .select()
          .from(productsTable)
          .where(eq(productsTable.id, row.target.productId))
          .get()
      : undefined;
  const categories = await db
    .select({
      categoryId: categoryTable.categoryId,
      categoryName: categoryTable.categoryName,
    })
    .from(categoryTable)
    .all();
  const attachments = attachmentProjection(row);
  const attachedIds = [
    ...attachments.photos,
    ...(attachments.printFile ? [attachments.printFile] : []),
  ].map(item => item.assetId);
  const identities = [
    ...(product
      ? [like(productAssets.references, `%"catalog:${product.id}"%`)]
      : []),
    ...(attachedIds.length ? [inArray(productAssets.id, attachedIds)] : []),
    ...(product?.publicFileServiceId
      ? [eq(productAssets.providerId, product.publicFileServiceId)]
      : []),
    ...[product?.image, ...parseGallery(product?.imageGallery)]
      .filter((value): value is string => Boolean(value))
      .map(value => {
        const assetId = value.match(
          /\/catalog\/assets\/([^/?#]+)\/image(?:[?#]|$)/,
        )?.[1];
        return assetId
          ? eq(productAssets.id, assetId)
          : eq(productAssets.objectKey, value);
      }),
  ];
  const assets = identities.length
    ? await db
        .select()
        .from(productAssets)
        .where(or(...identities))
        .all()
    : [];
  const requestedNames = row.state.answers.categoryNames;
  const requestedIds = requestedNames?.length
    ? categories
        .filter(category =>
          requestedNames.some(
            name =>
              normalizeCategoryName(name) ===
              normalizeCategoryName(category.categoryName),
          ),
        )
        .map(category => category.categoryId)
    : (row.state.answers.categoryIds ??
      (context.status === 'available'
        ? context.categories.map(category => category.categoryId)
        : []));
  const bindings = categories
    .filter(category => requestedIds.includes(category.categoryId))
    .sort((a, b) => a.categoryId - b.categoryId);
  const sourceBinding = JSON.stringify({
    target: row.target,
    revision: row.revision,
    answers: row.state.answers,
    context,
    attachments,
    product: product ?? null,
    categories: bindings,
    assets: assets
      .map(asset => ({
        id: asset.id,
        revision: asset.revision,
        status: asset.status,
        providerId: asset.providerId,
        fileUrl: asset.fileUrl,
        references: asset.references,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
  return {
    context,
    product,
    categories,
    attachments,
    attachedIds,
    assets,
    requestedIds,
    bindings,
    sourceBinding,
  };
}
function parseGallery(value: string | null | undefined): string[] {
  try {
    return z.array(z.string()).parse(JSON.parse(value ?? '[]'));
  } catch {
    return [];
  }
}
function stale(preparation: ProductPreparation): ProductPreparation {
  return {
    ...preparation,
    status: 'stale',
    readiness: { ready: false, submissionAuthorized: false },
    validation: [
      ...preparation.validation,
      {
        field: 'preparation',
        code: 'stale',
        message:
          'Prepare the current draft and catalog state again before submission.',
      },
    ],
  };
}
/** Read saved pricing without provider calls; changed revisions or catalog/asset/category identities invalidate it. */
export async function readCurrentPreparation(
  db: Database,
  ownerId: string,
  draftId: string,
): Promise<ProductPreparation | undefined> {
  const row = await readProductDraft(db, ownerId, draftId);
  if (!row?.preparation) return undefined;
  const preparation = productPreparationSchema.parse(row.preparation);
  if (preparation.draftRevision !== row.revision) return stale(preparation);
  if (
    preparation.snapshot &&
    preparation.snapshot.sourceBinding !==
      (await sources(db, row)).sourceBinding
  )
    return stale(preparation);
  return preparation;
}

/** Validate and estimate a private snapshot; never insert a Catalog Item or authorize submission. */
export async function prepareProduct(
  db: Database,
  env: Bindings,
  ownerId: string,
  draftId: string,
  expectedRevision: number,
  requestedAction?: 'create' | 'update' | 'delete',
): Promise<ProductPreparation> {
  const row = await readProductDraft(db, ownerId, draftId);
  if (!row) throw new AttachmentError(404, 'Draft not found');
  if (row.revision !== expectedRevision)
    throw new AttachmentError(409, 'Revision conflict');
  const current = await sources(db, row);
  const {
    product,
    context,
    categories,
    attachments,
    assets,
    attachedIds,
    requestedIds,
    bindings,
  } = current;
  const action =
    requestedAction ??
    row.state.interpretation?.intent ??
    (row.target.kind === 'new' ? 'create' : 'update');
  if ((action === 'create') !== (row.target.kind === 'new'))
    throw new AttachmentError(400, 'Action does not match the draft target');
  if (action === 'delete') {
    const preparation: ProductPreparation = {
      id: crypto.randomUUID(),
      draftRevision: row.revision,
      preparedAt: Date.now(),
      status: product ? 'ready' : 'blocked',
      readiness: { ready: Boolean(product), submissionAuthorized: false },
      validation: product
        ? []
        : [
            {
              field: 'product',
              code: 'unavailable',
              message: 'The selected product is unavailable.',
            },
          ],
      pricing: {
        currency: 'USD',
        productionCost: null,
        markupPercentage: product?.markupPercentage ?? null,
        onlinePrice: product?.price ?? null,
        inPersonPrice:
          product?.inPersonPrice == null ? null : product.inPersonPrice / 100,
        basis: null,
      },
      snapshot: product
        ? {
            target: row.target,
            action,
            productRevision: product.squareRevision,
            name: product.name,
            description: product.description,
            categoryIds:
              context.status === 'available'
                ? context.categories.map(category => category.categoryId)
                : [],
            filamentType: product.filamentType,
            color: product.color ?? '',
            publicFileServiceId: product.publicFileServiceId ?? '',
            stl: product.stl,
            image: product.image ?? '',
            imageGallery: parseGallery(product.imageGallery),
            primaryPhotoAssetId: null,
            assetIds: [],
            cleanupAssetIds: assets.map(asset => asset.id),
            assetRevisions: assets.map(asset => ({
              id: asset.id,
              revision: asset.revision,
            })),
            categoryBindings:
              context.status === 'available' ? context.categories : [],
            sourceBinding: current.sourceBinding,
          }
        : null,
    };
    return persistPreparation(
      db,
      ownerId,
      draftId,
      expectedRevision,
      current.sourceBinding,
      preparation,
    );
  }
  const answers = row.state.answers;
  const validation: ProductPreparation['validation'] = [];
  const invalid = (field: string, code: string, message: string) =>
    validation.push({ field, code, message });
  if (context.status === 'unavailable')
    invalid('product', 'unavailable', 'The selected product is unavailable.');
  const name = answers.name ?? product?.name ?? '';
  const description = answers.description ?? product?.description ?? '';
  const material = answers.filamentType ?? product?.filamentType ?? '';
  const color = answers.color ?? product?.color ?? '';
  const markup = numericAnswer(
    answers.markupPercentage,
    product?.markupPercentage ?? null,
  );
  const inPersonPrice = numericAnswer(
    answers.inPersonPrice,
    product?.inPersonPrice == null ? null : product.inPersonPrice / 100,
  );
  for (const [field, value] of [
    ['name', name],
    ['description', description],
    ['filamentType', material],
    ['color', color],
  ])
    if (!value.trim()) invalid(field, 'required', `Supply ${field}.`);
  if (markup === null || markup <= 0)
    invalid(
      'markupPercentage',
      'required',
      'Supply a positive explicit markup percentage; legacy unknown markup cannot be inferred from price.',
    );
  if (
    inPersonPrice === null ||
    !inPersonPriceSchema.safeParse(inPersonPrice).success ||
    !Number.isSafeInteger(Math.round(inPersonPrice * 100)) ||
    Math.abs(inPersonPrice * 100 - Math.round(inPersonPrice * 100)) > 1e-7
  )
    invalid(
      'inPersonPrice',
      'invalid',
      'Supply an independent USD in-person price with at most two decimal places.',
    );
  if (!requestedIds.length)
    invalid('categoryIds', 'required', 'Choose at least one current category.');
  if (
    new Set(requestedIds).size !== requestedIds.length ||
    requestedIds.some(
      id => !categories.some(category => category.categoryId === id),
    )
  )
    invalid(
      'categoryIds',
      'invalid',
      'Choose distinct available category identities.',
    );
  for (const categoryName of answers.categoryNames ?? [])
    if (
      categories.filter(
        category =>
          normalizeCategoryName(category.categoryName) ===
          normalizeCategoryName(categoryName),
      ).length !== 1
    )
      invalid(
        'categoryNames',
        'unresolved',
        `Category “${categoryName}” must resolve to one current identity.`,
      );
  validation.push(...attachments.validation);
  if (attachments.transfers.some(item => item.status !== 'saved'))
    invalid(
      'attachments',
      'incomplete',
      'Resolve unfinished attachment transfers before preparation.',
    );
  if (row.attachments?.catalogHydrated && !attachments.photos.length)
    invalid('photos', 'required', 'Keep at least one product photo.');
  if (attachments.photos.length > 5)
    invalid('photos', 'limit', 'Use at most five photos.');
  if (product && attachments.photos.length && !row.attachments?.catalogHydrated) invalid('photos','reopen_catalog','Start a new draft to load the existing gallery before editing photos.');
  const primary = attachments.photos.find(
    photo => photo.id === attachments.primaryPhotoId,
  );
  if (attachments.photos.length && !primary)
    invalid('primaryPhotoId', 'required', 'Choose a saved primary photo.');
  if (
    attachments.photoOrder.length !== attachments.photos.length ||
    new Set(attachments.photoOrder).size !== attachments.photos.length ||
    attachments.photoOrder.some(
      id => !attachments.photos.some(photo => photo.id === id),
    )
  )
    invalid(
      'photoOrder',
      'invalid',
      'Photo order must contain every saved photo once.',
    );
  if (
    primary?.catalogSource &&
    !primary.catalogSource.managed &&
    primary.catalogSource.url !== product?.image
  )
    invalid(
      'photos',
      'legacy_primary_upload_required',
      'Upload this legacy photo before selecting it as a new Square primary image.',
    );
  const image = primary?.imageUrl ?? product?.image ?? '';
  if (!image) invalid('photos', 'required', 'Supply a product photo.');
  const publicFileServiceId =
    attachments.printFile?.publicFileServiceId ??
    product?.publicFileServiceId ??
    '';
  if (!publicFileServiceId)
    invalid('printFile', 'required', 'Supply a confirmed print file.');
  for (const id of attachedIds) {
    const asset = assets.find(candidate => candidate.id === id);
    const attachment = [
      ...attachments.photos,
      ...(attachments.printFile ? [attachments.printFile] : []),
    ].find(item => item.assetId === id);
    const retained = attachment?.catalogSource;
    const retainedHere =
      !!retained &&
      retained.productId === product?.id &&
      [product?.image, ...parseGallery(product?.imageGallery)].includes(
        retained.url,
      );
    if (retained && !retainedHere)
      invalid(
        'attachments',
        'catalog_changed',
        'The saved gallery changed; reload the product before editing.',
      );
    if (
      retainedHere &&
      retained?.managed &&
      (!asset || asset.status !== 'active')
    )
      invalid(
        'attachments',
        'unavailable',
        'A retained catalog asset is no longer active; reload the product.',
      );
    if (
      !retainedHere &&
      (!asset ||
        asset.ownerId !== ownerId ||
        asset.draftId !== draftId ||
        asset.status !== 'active')
    )
      invalid(
        'attachments',
        'ownership',
        'Every attached asset must be active and owned by this draft.',
      );
    if (
      asset &&
      attachment?.kind === 'print' &&
      asset.providerId !== attachment.publicFileServiceId
    )
      invalid(
        'printFile',
        'identity',
        'The confirmed file identity does not match its asset.',
      );
  }
  if (assets.some(asset => asset.status !== 'active'))
    invalid(
      'attachments',
      'unavailable',
      'A retained catalog asset is unavailable.',
    );
  const preparation: ProductPreparation = {
    id: crypto.randomUUID(),
    draftRevision: row.revision,
    preparedAt: Date.now(),
    status: 'blocked',
    readiness: { ready: false, submissionAuthorized: false },
    validation,
    pricing: {
      currency: 'USD',
      productionCost: null,
      markupPercentage: markup && markup > 0 ? markup : null,
      onlinePrice: null,
      inPersonPrice,
      basis: null,
    },
    snapshot: null,
  };
  if (!validation.length) {
    try {
      if (!env.SLANT_API_V2) throw new Error('Production service unavailable');
      const response = await fetch(slantV2Url(env, 'filaments'), {
        headers: { Authorization: `Bearer ${env.SLANT_API_V2}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Production options unavailable');
      const options = filamentsSchema
        .parse(await response.json())
        .data.filter(
          option =>
            option.available &&
            option.provider.toLowerCase() === 'slant 3d' &&
            option.profile === material &&
            [
              option.color.toLowerCase(),
              option.hexValue.toLowerCase(),
            ].includes(color.toLowerCase()),
        );
      if (options.length !== 1)
        invalid(
          'filamentType',
          'unsupported_basis',
          'Choose one unambiguous available Slant3D material and color.',
        );
      else {
        const file = await getSlant3DFile(env, publicFileServiceId);
        if (file.publicFileServiceId !== publicFileServiceId || !file.fileURL)
          throw new Error('Confirmed print file unavailable');
        const option = options[0];
        const estimate = await estimateSlant3DFile(env, publicFileServiceId, {
          filamentId: option.publicId,
          quantity: 1,
        });
        if (
          estimate.publicFileServiceId !== publicFileServiceId ||
          estimate.filamentId !== option.publicId ||
          estimate.quantity !== 1
        )
          throw new Error('Estimate basis mismatch');
        const cost = [
          estimate.total,
          estimate.estimatedCost,
          estimate.pricePerUnit,
          estimate.subtotal,
        ].find(
          value =>
            typeof value === 'number' && Number.isFinite(value) && value > 0,
        );
        if (cost === undefined) throw new Error('Invalid production estimate');
        const onlinePrice = calculateMarkupPrice(cost, markup!);
        if (
          !Number.isFinite(onlinePrice) ||
          !Number.isSafeInteger(Math.round(onlinePrice * 100))
        )
          throw new Error('Price exceeds supported range');
        preparation.pricing = {
          currency: 'USD',
          productionCost: cost,
          markupPercentage: markup,
          onlinePrice,
          inPersonPrice,
          basis: {
            publicFileServiceId,
            filamentId: option.publicId,
            material: option.profile,
            color: option.color,
            quantity: 1,
          },
        };
        preparation.snapshot = {
          target: row.target,
          action,
          productRevision: product?.squareRevision ?? null,
          name,
          description,
          categoryIds: requestedIds,
          filamentType: material,
          color,
          publicFileServiceId,
          stl: file.fileURL,
          image,
          imageGallery: attachments.photos.length
            ? attachments.photoOrder.map(
                id =>
                  attachments.photos.find(photo => photo.id === id)!
                    .catalogSource?.url ??
                  `/catalog/assets/${attachments.photos.find(photo => photo.id === id)!.assetId}/image`,
              )
            : parseGallery(product?.imageGallery),
          primaryPhotoAssetId:
            (primary?.catalogSource && !primary.catalogSource.managed
              ? null
              : primary?.assetId) ??
            assets.find(
              asset =>
                asset.objectKey === product?.image ||
                product?.image?.includes(`/catalog/assets/${asset.id}/image`),
            )?.id ??
            null,
          assetIds: assets
            .filter(asset =>
              asset.kind === 'photo'
                ? attachments.photos.length
                  ? attachments.photos.some(photo => photo.assetId === asset.id)
                  : [
                      product?.image,
                      ...parseGallery(product?.imageGallery),
                    ].some(
                      value =>
                        value === asset.objectKey ||
                        value?.includes(`/catalog/assets/${asset.id}/image`),
                    )
                : asset.providerId === publicFileServiceId,
            )
            .map(asset => asset.id),
          cleanupAssetIds: assets.map(asset => asset.id),
          assetRevisions: assets.map(asset => ({
            id: asset.id,
            revision: asset.revision,
          })),
          categoryBindings: bindings,
          sourceBinding: current.sourceBinding,
        } satisfies PreparedSnapshot;
        preparation.status = 'ready';
        preparation.readiness.ready = true;
      }
    } catch {
      preparation.status = 'unavailable';
      invalid(
        'pricing',
        'unavailable',
        'Authoritative production pricing is unavailable; retry preparation.',
      );
    }
  }
  return persistPreparation(
    db,
    ownerId,
    draftId,
    expectedRevision,
    current.sourceBinding,
    preparation,
  );
}
/** Save only against the same draft and source state that was validated. */
async function persistPreparation(
  db: Database,
  ownerId: string,
  draftId: string,
  expectedRevision: number,
  sourceBinding: string,
  preparation: ProductPreparation,
) {
  const latest = await readProductDraft(db, ownerId, draftId);
  if (
    !latest ||
    latest.revision !== expectedRevision ||
    (await sources(db, latest)).sourceBinding !== sourceBinding
  )
    throw new AttachmentError(
      409,
      'Draft or catalog changed during preparation',
    );
  const [saved] = await db
    .update(productDrafts)
    .set({ preparation })
    .where(
      and(
        eq(productDrafts.id, draftId),
        eq(productDrafts.ownerId, ownerId),
        eq(productDrafts.revision, expectedRevision),
        eq(productDrafts.status, 'active'),
      ),
    )
    .returning({ id: productDrafts.id });
  if (!saved) throw new AttachmentError(409, 'Revision conflict');
  return productPreparationSchema.parse(preparation);
}
