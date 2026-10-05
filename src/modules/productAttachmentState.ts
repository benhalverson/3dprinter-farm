import type { Slant3DFilePlaceholder } from '../lib/slant3d-v2-files';
import type {
  AttachmentCleanup,
  AttachmentTransfer,
  SavedAttachment,
} from './productAttachmentContracts';

export type TransferRecord = AttachmentTransfer & {
  placeholder?: Slant3DFilePlaceholder;
  presignedUrl?: string;
  phase:
    | 'intent'
    | 'allocating'
    | 'ready'
    | 'uploading'
    | 'confirming'
    | 'done';
};
export type AttachmentState = {
  photos: SavedAttachment[];
  printFile: SavedAttachment | null;
  primaryPhotoId: string | null;
  primaryExplicit: boolean;
  photoOrder: string[];
  transfers: TransferRecord[];
  abandonedTransfers?: TransferRecord[];
  cleanup: AttachmentCleanup[];
};
export const emptyAttachments = (): AttachmentState => ({
  photos: [],
  printFile: null,
  primaryPhotoId: null,
  primaryExplicit: false,
  photoOrder: [],
  transfers: [],
  cleanup: [],
});
