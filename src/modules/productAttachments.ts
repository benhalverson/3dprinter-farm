import { and, eq } from 'drizzle-orm';
import { productAssets, productDrafts } from '../db/schema';
import type { WorkerEnv } from '../factory';
import {
  confirmSlant3DUpload,
  createSlant3DDirectUpload,
} from '../lib/slant3d-v2-files';
import type { Bindings } from '../types';
import {
  AttachmentError,
  assetKey,
  changeAsset,
  cleanupAsset,
  ensureAsset,
  readAsset,
  retryAssetReleases,
} from './productAssets';
import type {
  AttachmentEdit,
  AttachmentIntent,
  AttachmentUpload,
  ProductAttachments,
} from './productAttachmentContracts';
import {
  type AttachmentState,
  emptyAttachments,
  type TransferRecord,
} from './productAttachmentState';
import {
  boundedBytes,
  decryptPhoto,
  detectPhoto,
  encryptPhoto,
  MAX_PHOTO_BYTES,
  newPhotoKey,
} from './productPhotoBytes';

type Database = WorkerEnv['Variables']['db'];
type Draft = typeof productDrafts.$inferSelect;
export function attachmentProjection(row: Draft): ProductAttachments {
  const state = row.attachments ?? emptyAttachments();
  return {
    photos: state.photos,
    printFile: state.printFile,
    primaryPhotoId: state.primaryPhotoId,
    photoOrder: state.photoOrder,
    transfers: state.transfers.map(
      ({ phase, placeholder, presignedUrl, ...transfer }) => ({
        ...transfer,
        status: transfer.status === 'pending' ? 'incomplete' : transfer.status,
        requiresReselection:
          transfer.status === 'pending' ||
          transfer.status === 'incomplete' ||
          transfer.status === 'failed',
      }),
    ),
    validation:
      state.photos.length > 1 && !state.primaryExplicit
        ? [
            {
              field: 'primaryPhotoId',
              code: 'primary_required',
              message: 'Choose the primary product photo',
            },
          ]
        : [],
    cleanup: state.cleanup,
  };
}
export async function attachmentDraft(
  db: Database,
  ownerId: string,
  id: string,
  revision?: number,
  discarded = false,
) {
  const row = await db
    .select()
    .from(productDrafts)
    .where(and(eq(productDrafts.id, id), eq(productDrafts.ownerId, ownerId)))
    .get();
  if (!row || (!discarded && row.status === 'discarded'))
    throw new AttachmentError(404, 'Draft not found');
  if (revision !== undefined && row.revision !== revision)
    throw new AttachmentError(409, 'Revision conflict');
  return row;
}
export async function writeAttachments(
  db: Database,
  row: Draft,
  attachments: AttachmentState,
  discard = false,
) {
  const [updated] = await db
    .update(productDrafts)
    .set({
      attachments,
      revision: row.revision + 1,
      updatedAt: Date.now(),
      ...(discard
        ? {
            status: 'discarded' as const,
            state: { answers: {}, pendingQuestions: [], history: [] },
          }
        : {}),
    })
    .where(
      and(
        eq(productDrafts.id, row.id),
        eq(productDrafts.ownerId, row.ownerId),
        eq(productDrafts.revision, row.revision),
        eq(productDrafts.status, row.status),
      ),
    )
    .returning();
  if (!updated) throw new AttachmentError(409, 'Revision conflict');
  return updated;
}
function transferIn(row: Draft, id: string) {
  const transfer = row.attachments?.transfers.find(item => item.id === id);
  if (!transfer) throw new AttachmentError(404, 'Transfer not found');
  return transfer;
}
async function updateTransfer(
  db: Database,
  row: Draft,
  transfer: TransferRecord,
) {
  const state = row.attachments!;
  const current = state.transfers.find(item => item.id === transfer.id);
  if (
    !current ||
    current.attachmentId !== transfer.attachmentId ||
    current.status === 'saved'
  )
    return row;
  return writeAttachments(db, row, {
    ...state,
    transfers: state.transfers.map(item =>
      item.id === transfer.id ? transfer : item,
    ),
  });
}
function uploadFor(row: Draft, transfer: TransferRecord): AttachmentUpload {
  return {
    id: transfer.id,
    upload:
      transfer.phase !== 'ready'
        ? null
        : {
            method: 'PUT',
            url:
              transfer.kind === 'photo'
                ? `/admin/product-drafts/${row.id}/attachments/transfers/${transfer.id}/content?expectedRevision=${row.revision}`
                : transfer.presignedUrl!,
            headers: {
              'Content-Type':
                transfer.kind === 'photo'
                  ? 'application/octet-stream'
                  : 'application/sla',
            },
          },
  };
}
async function assetFor(db: Database, row: Draft, transfer: TransferRecord) {
  return ensureAsset(db, {
    id: transfer.attachmentId,
    ownerId: row.ownerId,
    draftId: row.id,
    kind: transfer.kind,
    objectKey: assetKey(transfer.attachmentId),
    providerId: null,
    fileUrl: null,
    contentType: null,
    encryptionKey: newPhotoKey(),
    references: [`draft:${row.id}`, `transfer:${transfer.id}`],
    status: 'active',
    revision: 1,
  });
}
export async function createAttachmentIntent(
  db: Database,
  env: Bindings,
  ownerId: string,
  id: string,
  input: AttachmentIntent,
) {
  let row = await attachmentDraft(db, ownerId, id, input.expectedRevision);
  const state = row.attachments ?? emptyAttachments();
  if (input.kind === 'photo' && input.size > MAX_PHOTO_BYTES)
    throw new AttachmentError(400, 'Photo exceeds 5,000,000 bytes');
  const saved =
    input.kind === 'photo'
      ? state.photos
      : state.printFile
        ? [state.printFile]
        : [];
  if (input.replacesId && !saved.some(item => item.id === input.replacesId))
    throw new AttachmentError(400, 'Replacement attachment not found');
  const pending = state.transfers.filter(
    item => item.kind === input.kind && item.status !== 'saved',
  );
  if (
    input.replacesId &&
    pending.some(item => item.replacesId === input.replacesId)
  )
    throw new AttachmentError(409, 'A replacement is already pending');
  if (
    !input.replacesId &&
    saved.length + pending.filter(item => !item.replacesId).length >=
      (input.kind === 'photo' ? 5 : 1)
  )
    throw new AttachmentError(
      400,
      input.kind === 'photo'
        ? 'Five photos maximum; replace an existing photo'
        : 'Replace the existing print file',
    );
  const transfer: TransferRecord = {
    id: crypto.randomUUID(),
    attachmentId: crypto.randomUUID(),
    kind: input.kind,
    name: input.name,
    size: input.size,
    contentType: null,
    status: 'pending',
    replacesId: input.replacesId ?? null,
    error: null,
    requiresReselection: true,
    phase: 'intent',
  };
  row = await writeAttachments(db, row, {
    ...state,
    transfers: [...state.transfers, transfer],
  });
  return prepareTransfer(db, env, row, transfer);
}
async function prepareTransfer(
  db: Database,
  env: Bindings,
  row: Draft,
  transfer: TransferRecord,
) {
  await assetFor(db, row, transfer);
  if (transfer.kind === 'photo') {
    transfer = { ...transfer, phase: 'ready', status: 'pending', error: null };
    row = await updateTransfer(db, row, transfer);
  } else {
    // The allocation attempt is durable before the non-idempotent provider call.
    transfer = {
      ...transfer,
      phase: 'allocating',
      status: 'unresolved',
      requiresReselection: false,
    };
    row = await updateTransfer(db, row, transfer);
    try {
      const result = await createSlant3DDirectUpload(env, {
        name: `${transfer.id}-${transfer.name}`,
        ownerId: row.ownerId,
      });
      transfer = {
        ...transfer,
        placeholder: result.filePlaceholder,
        presignedUrl: result.presignedUrl,
        phase: 'ready',
        status: 'pending',
        requiresReselection: true,
      };
      const asset = await readAsset(db, transfer.attachmentId);
      if (!asset) throw new Error('Asset unavailable');
      await changeAsset(db, asset, {
        providerId: result.filePlaceholder.publicFileServiceId,
      });
      row = await attachmentDraft(db, row.ownerId, row.id, undefined, true);
      row = await updateTransfer(db, row, transfer);
    } catch {
      row = await attachmentDraft(db, row.ownerId, row.id, undefined, true);
      transfer = {
        ...transfer,
        status: 'unresolved',
        phase: transfer.placeholder ? 'confirming' : 'allocating',
        error:
          'Print upload allocation has an unknown outcome; retain this transfer for recovery',
      };
      row = await updateTransfer(db, row, transfer);
    }
  }
  return { row, transfer: uploadFor(row, transfer) };
}
export async function retryAttachmentTransfer(
  db: Database,
  env: Bindings,
  ownerId: string,
  id: string,
  transferId: string,
  revision: number,
) {
  let row = await attachmentDraft(db, ownerId, id, revision);
  let transfer = transferIn(row, transferId);
  if (transfer.kind === 'print' && transfer.status === 'unresolved') {
    const state = row.attachments!;
    const replacement: TransferRecord = {
      ...transfer,
      attachmentId: crypto.randomUUID(),
      placeholder: undefined,
      presignedUrl: undefined,
      phase: 'intent',
      status: 'incomplete',
      requiresReselection: true,
      error: null,
    };
    row = await writeAttachments(db, row, {
      ...state,
      transfers: state.transfers.map(item =>
        item.id === transfer.id ? replacement : item,
      ),
      abandonedTransfers: [...(state.abandonedTransfers ?? []), transfer],
      cleanup: [
        ...state.cleanup,
        {
          id: transfer.attachmentId,
          assetId: transfer.attachmentId,
          status: 'pending',
          reason: 'Previous print operation has an unknown outcome',
        },
      ],
    });
    transfer = replacement;
  }
  if (transfer.phase === 'intent')
    return prepareTransfer(db, env, row, transfer);
  if (transfer.phase === 'uploading') {
    row = await confirmAttachment(db, env, ownerId, id, transferId, revision);
    transfer = transferIn(row, transferId);
    if (transfer.phase === 'intent')
      return prepareTransfer(db, env, row, transfer);
  } else if (transfer.phase === 'ready') {
    row = await updateTransfer(db, row, {
      ...transfer,
      status: 'pending',
      error: null,
    });
  }
  return { row, transfer: uploadFor(row, transfer) };
}
async function finishAttachment(
  db: Database,
  row: Draft,
  transfer: TransferRecord,
  contentType: string,
  providerId: string | null,
  fileUrl: string | null,
) {
  // Provider completion may race a discard or a save: reread and CAS the latest
  // complete draft, preserving answers and respecting the discard tombstone.
  row = await attachmentDraft(db, row.ownerId, row.id, undefined, true);
  const state = row.attachments!;
  const current = state.transfers.find(item => item.id === transfer.id);
  if (
    current?.status === 'saved' &&
    current.attachmentId === transfer.attachmentId
  )
    return row;
  const asset = await readAsset(db, transfer.attachmentId);
  if (!asset) throw new Error('Asset recovery record missing');
  if (asset.status !== 'active')
    throw new AttachmentError(
      409,
      'Asset cleanup has already claimed this transfer',
    );
  const superseded = !current || current.attachmentId !== transfer.attachmentId;
  if (
    !superseded &&
    current.phase !== 'uploading' &&
    current.phase !== 'confirming'
  )
    throw new AttachmentError(
      409,
      'Transfer is no longer eligible for completion',
    );
  await changeAsset(db, asset, {
    contentType,
    providerId,
    fileUrl,
    references: asset.references.filter(
      reference =>
        reference !== `transfer:${transfer.id}` &&
        ((!superseded && row.status !== 'discarded') ||
          reference !== `draft:${row.id}`),
    ),
  });
  // A missing-object recovery rotates the asset generation. A late original
  // completion resolves only its protected cleanup record, never the new slot.
  if (superseded) return row;
  const completed = {
    ...transfer,
    phase: 'done' as const,
    status: 'saved' as const,
    contentType,
    requiresReselection: false,
    error: null,
  };
  const next = {
    ...state,
    transfers: state.transfers.map(item =>
      item.id === transfer.id ? completed : item,
    ),
  };
  if (row.status === 'discarded') {
    return writeAttachments(db, row, next);
  }
  const saved = {
    id: transfer.attachmentId,
    assetId: transfer.attachmentId,
    kind: transfer.kind,
    name: transfer.name,
    size: transfer.size,
    contentType,
    status: 'saved' as const,
    publicFileServiceId: providerId,
    imageUrl:
      transfer.kind === 'photo'
        ? `/admin/product-drafts/${row.id}/attachments/${transfer.attachmentId}/image`
        : null,
  };
  if (transfer.kind === 'photo') {
    const index = next.photos.findIndex(
      item => item.id === transfer.replacesId,
    );
    next.photos =
      index < 0
        ? [...next.photos, saved]
        : next.photos.map((item, position) =>
            position === index ? saved : item,
          );
    next.photoOrder =
      index < 0
        ? [...next.photoOrder, saved.id]
        : next.photoOrder.map(item =>
            item === transfer.replacesId ? saved.id : item,
          );
    if (next.primaryPhotoId === transfer.replacesId || next.photos.length === 1)
      next.primaryPhotoId = saved.id;
    if (next.photos.length > 1 && !next.primaryExplicit)
      next.primaryPhotoId = null;
  } else {
    next.printFile = saved;
  }
  if (transfer.replacesId)
    next.cleanup = [
      ...next.cleanup,
      {
        id: transfer.replacesId,
        assetId: transfer.replacesId,
        status: 'pending',
        reason: null,
      },
    ];
  row = await writeAttachments(db, row, next);
  if (transfer.replacesId)
    await releaseDraftAsset(db, row, transfer.replacesId);
  return row;
}
export async function uploadAttachmentPhoto(
  db: Database,
  env: Bindings,
  ownerId: string,
  id: string,
  transferId: string,
  revision: number,
  stream: ReadableStream<Uint8Array> | null,
) {
  let row = await attachmentDraft(db, ownerId, id, revision);
  let transfer = transferIn(row, transferId);
  if (transfer.kind !== 'photo' || transfer.phase !== 'ready')
    throw new AttachmentError(409, 'Transfer requires recovery before upload');
  let bytes: Uint8Array;
  let contentType: string;
  try {
    bytes = await boundedBytes(stream);
    if (bytes.length !== transfer.size)
      throw new AttachmentError(
        400,
        'Photo size differs from the selected file',
      );
    contentType = await detectPhoto(bytes);
  } catch (error) {
    if (error instanceof AttachmentError)
      await updateTransfer(db, row, {
        ...transfer,
        status: 'failed',
        error: error.message,
        requiresReselection: true,
      });
    throw error;
  }
  transfer = {
    ...transfer,
    status: 'unresolved',
    phase: 'uploading',
    contentType,
    requiresReselection: false,
  };
  row = await updateTransfer(db, row, transfer);
  const asset = await assetFor(db, row, transfer);
  try {
    const encrypted = await encryptPhoto(bytes, asset.encryptionKey, asset.id);
    const result = await env.PHOTO_BUCKET.put(asset.objectKey, encrypted, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/octet-stream' },
    });
    if (!result) throw new Error('Object identity already exists');
  } catch {
    row = await attachmentDraft(db, ownerId, id, undefined, true);
    return updateTransfer(db, row, {
      ...transfer,
      error: 'Photo upload outcome is unknown; retry to check storage',
    });
  }
  return finishAttachment(db, row, transfer, contentType, null, null);
}
export async function confirmAttachment(
  db: Database,
  env: Bindings,
  ownerId: string,
  id: string,
  transferId: string,
  revision: number,
) {
  let row = await attachmentDraft(db, ownerId, id, revision, true);
  let transfer = transferIn(row, transferId);
  if (transfer.status === 'saved') return row;
  if (transfer.kind === 'photo') {
    if (transfer.phase !== 'uploading')
      throw new AttachmentError(409, 'Photo requires re-selection');
    const object = await env.PHOTO_BUCKET.get(assetKey(transfer.attachmentId));
    if (!object) {
      if (row.status === 'discarded') return row;
      const state = row.attachments!;
      const replacement = {
        ...transfer,
        attachmentId: crypto.randomUUID(),
        phase: 'intent' as const,
        status: 'incomplete' as const,
        requiresReselection: true,
        error:
          'Select this photo again; the previous upload remains protected until its outcome is known',
      };
      row = await writeAttachments(db, row, {
        ...state,
        transfers: state.transfers.map(item =>
          item.id === transfer.id ? replacement : item,
        ),
        abandonedTransfers: [...(state.abandonedTransfers ?? []), transfer],
        cleanup: [
          ...state.cleanup,
          {
            id: transfer.attachmentId,
            assetId: transfer.attachmentId,
            status: 'pending',
            reason: 'Previous upload may still complete',
          },
        ],
      });
      await assetFor(db, row, replacement);
      return row;
    }
    const asset = await readAsset(db, transfer.attachmentId);
    if (!asset) throw new AttachmentError(409, 'Asset recovery record missing');
    const bytes = new Uint8Array(
      await decryptPhoto(
        await object.arrayBuffer(),
        asset.encryptionKey,
        transfer.attachmentId,
      ),
    );
    if (bytes.length !== transfer.size)
      throw new AttachmentError(
        409,
        'Stored photo identity does not match transfer',
      );
    return finishAttachment(
      db,
      row,
      transfer,
      await detectPhoto(bytes),
      null,
      null,
    );
  }
  if (!transfer.placeholder)
    throw new AttachmentError(409, 'Print allocation outcome unresolved');
  const placeholder = transfer.placeholder;
  transfer = {
    ...transfer,
    phase: 'confirming',
    status: 'unresolved',
    requiresReselection: false,
  };
  row = await updateTransfer(db, row, transfer);
  try {
    const result = await confirmSlant3DUpload(env, placeholder);
    if (result.publicFileServiceId !== placeholder.publicFileServiceId)
      throw new Error('Provider returned another file');
    return await finishAttachment(
      db,
      row,
      transfer,
      'application/sla',
      result.publicFileServiceId,
      result.fileURL,
    );
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    row = await attachmentDraft(db, ownerId, id, undefined, true);
    return updateTransfer(db, row, {
      ...transfer,
      error: 'Print confirmation outcome unresolved; retry confirmation',
    });
  }
}
export async function editAttachments(
  db: Database,
  ownerId: string,
  id: string,
  input: AttachmentEdit,
) {
  const row = await attachmentDraft(db, ownerId, id, input.expectedRevision);
  const state = row.attachments ?? emptyAttachments();
  const ids = state.photos.map(item => item.id);
  if (
    input.photoOrder &&
    (input.photoOrder.length !== ids.length ||
      new Set(input.photoOrder).size !== ids.length ||
      input.photoOrder.some(item => !ids.includes(item)))
  )
    throw new AttachmentError(
      400,
      'Photo order must contain each saved photo exactly once',
    );
  if (input.primaryPhotoId && !ids.includes(input.primaryPhotoId))
    throw new AttachmentError(400, 'Primary must be a saved photo');
  return writeAttachments(db, row, {
    ...state,
    ...(input.photoOrder ? { photoOrder: input.photoOrder } : {}),
    ...(input.primaryPhotoId !== undefined
      ? {
          primaryPhotoId: ids.length === 1 ? ids[0] : input.primaryPhotoId,
          primaryExplicit: input.primaryPhotoId !== null,
        }
      : {}),
  });
}
async function releaseDraftAsset(db: Database, row: Draft, id: string) {
  const asset = await readAsset(db, id);
  if (asset && asset.status === 'active')
    await changeAsset(db, asset, {
      references: asset.references.filter(
        reference => reference !== `draft:${row.id}`,
      ),
    });
}
export async function removeAttachment(
  db: Database,
  ownerId: string,
  id: string,
  attachmentId: string,
  revision: number,
) {
  let row = await attachmentDraft(db, ownerId, id, revision);
  const state = row.attachments ?? emptyAttachments();
  const transfer = state.transfers.find(
    item => item.attachmentId === attachmentId,
  );
  if (
    !state.photos.some(item => item.id === attachmentId) &&
    state.printFile?.id !== attachmentId &&
    !transfer
  )
    throw new AttachmentError(404, 'Attachment not found');
  if (
    transfer &&
    (transfer.status === 'unresolved' ||
      state.transfers.some(
        item => item.replacesId === attachmentId && item.status !== 'saved',
      ))
  )
    throw new AttachmentError(
      409,
      'Resolve the pending transfer before removing this attachment',
    );
  const photos = state.photos.filter(item => item.id !== attachmentId);
  const primaryRemoved = state.primaryPhotoId === attachmentId;
  row = await writeAttachments(db, row, {
    ...state,
    photos,
    printFile: state.printFile?.id === attachmentId ? null : state.printFile,
    photoOrder: state.photoOrder.filter(item => item !== attachmentId),
    primaryPhotoId:
      photos.length === 1
        ? photos[0].id
        : primaryRemoved
          ? null
          : state.primaryPhotoId,
    primaryExplicit: primaryRemoved ? false : state.primaryExplicit,
    transfers: state.transfers.filter(
      item => item.attachmentId !== attachmentId,
    ),
    abandonedTransfers: [
      ...(state.abandonedTransfers ?? []),
      ...(transfer ? [transfer] : []),
    ],
    cleanup: [
      ...state.cleanup,
      {
        id: attachmentId,
        assetId: attachmentId,
        status: 'pending',
        reason: null,
      },
    ],
  });
  const asset = await readAsset(db, attachmentId);
  if (asset && asset.status === 'active')
    await changeAsset(db, asset, {
      references: asset.references.filter(
        reference =>
          reference !== `draft:${id}` &&
          reference !== `transfer:${transfer?.id}`,
      ),
    });
  return row;
}
export async function discardAttachments(
  db: Database,
  ownerId: string,
  id: string,
  revision: number,
) {
  const row = await attachmentDraft(db, ownerId, id, revision, true);
  if (row.status === 'discarded') return row;
  const state = row.attachments ?? emptyAttachments();
  const ids = new Set([
    ...state.photos.map(item => item.assetId),
    ...state.transfers.map(item => item.attachmentId),
    ...(state.printFile ? [state.printFile.assetId] : []),
    ...state.cleanup.map(item => item.assetId),
  ]);
  return writeAttachments(
    db,
    row,
    {
      ...state,
      photos: [],
      printFile: null,
      photoOrder: [],
      primaryPhotoId: null,
      cleanup: [...ids].map(assetId => ({
        id: assetId,
        assetId,
        status: 'pending',
        reason: null,
      })),
    },
    true,
  );
}
export async function retryAttachmentCleanup(
  db: Database,
  env: Bindings,
  ownerId: string,
  id: string,
  revision: number,
) {
  let row = await attachmentDraft(db, ownerId, id, revision, true);
  // Tombstones are the only read surface after discard. Resolve known transfer
  // identities here so cleanup recovery never depends on a vanished browser tab.
  if (row.status === 'discarded') {
    for (const transfer of row.attachments!.transfers) {
      if (
        transfer.status !== 'unresolved' ||
        (transfer.kind === 'print' && !transfer.placeholder)
      )
        continue;
      try {
        row = await confirmAttachment(
          db,
          env,
          ownerId,
          id,
          transfer.id,
          row.revision,
        );
      } catch {
        // Missing/unavailable bytes or a concurrent recovery are not proof that
        // a provider operation stopped. Keep its durable protection and retry.
        row = await attachmentDraft(db, ownerId, id, undefined, true);
      }
    }
  }
  const state = row.attachments ?? emptyAttachments();
  const cleanup = [];
  const assets = await db
    .select()
    .from(productAssets)
    .where(eq(productAssets.draftId, id))
    .all();
  await retryAssetReleases(db, assets);
  for (const item of state.cleanup) {
    let asset = await readAsset(db, item.assetId);
    const abandoned = state.abandonedTransfers?.find(
      attempt => attempt.attachmentId === item.assetId,
    );
    if (
      asset &&
      abandoned &&
      asset.references.includes(`transfer:${abandoned.id}`)
    ) {
      let resolved = abandoned.status !== 'unresolved';
      if (!resolved && abandoned.kind === 'print' && abandoned.placeholder) {
        try {
          const result = await confirmSlant3DUpload(env, abandoned.placeholder);
          resolved =
            result.publicFileServiceId ===
            abandoned.placeholder.publicFileServiceId;
        } catch {
          // The prior operation remains protected when the provider is unavailable.
        }
      }
      const object =
        !resolved && abandoned.kind === 'photo'
          ? await env.PHOTO_BUCKET.get(asset.objectKey)
          : null;
      if (object) {
        const bytes = new Uint8Array(
          await decryptPhoto(
            await object.arrayBuffer(),
            asset.encryptionKey,
            asset.id,
          ),
        );
        if (bytes.length !== abandoned.size)
          throw new AttachmentError(
            409,
            'Abandoned upload identity does not match',
          );
        await detectPhoto(bytes);
        resolved = true;
      }
      if (resolved) {
        asset = await changeAsset(db, asset, {
          references: asset.references.filter(
            reference => reference !== `transfer:${abandoned.id}`,
          ),
        });
      }
    }
    if (asset && asset.status === 'active') {
      const transfer = state.transfers.find(
        transfer => transfer.attachmentId === asset.id,
      );
      const unresolved = transfer?.status === 'unresolved';
      await changeAsset(db, asset, {
        references: asset.references.filter(
          reference =>
            reference !== `draft:${id}` &&
            (unresolved || reference !== `transfer:${transfer?.id}`),
        ),
      });
    }
    cleanup.push({ ...item, ...(await cleanupAsset(db, env, item.assetId)) });
  }
  row = await attachmentDraft(db, ownerId, id, undefined, true);
  const latest = row.attachments ?? emptyAttachments();
  const outcomes = new Map(cleanup.map(item => [item.id, item]));
  return writeAttachments(db, row, {
    ...latest,
    cleanup: latest.cleanup.map(item => outcomes.get(item.id) ?? item),
  });
}
export function cleanupResponse(row: Draft) {
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    cleanup: (row.attachments ?? emptyAttachments()).cleanup,
  };
}
export async function readAttachmentPhoto(
  db: Database,
  env: Bindings,
  ownerId: string,
  id: string,
  attachmentId: string,
) {
  const row = await attachmentDraft(db, ownerId, id);
  const photo = row.attachments?.photos.find(item => item.id === attachmentId);
  if (!photo) throw new AttachmentError(404, 'Photo not found');
  const object = await env.PHOTO_BUCKET.get(assetKey(photo.assetId));
  if (!object) throw new AttachmentError(404, 'Photo not found');
  const asset = await readAsset(db, photo.assetId);
  if (!asset) throw new AttachmentError(404, 'Photo not found');
  return {
    bytes: await decryptPhoto(
      await object.arrayBuffer(),
      asset.encryptionKey,
      photo.assetId,
    ),
    contentType: photo.contentType,
  };
}
