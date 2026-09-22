export const MAX_GENERATED_ASSET_DOWNLOADS = 20;

export type GeneratedAssetDownloadState =
  | 'requested'
  | 'started'
  | 'complete'
  | 'failed'
  | 'unconfirmed';

export interface GeneratedAssetDownloadItem {
  id: string;
  assetId: string;
  filename: string;
  state: GeneratedAssetDownloadState;
  detail: string | null;
}

export interface GeneratedAssetDownloadBatch {
  id: string;
  sessionId: string;
  logicalMessageId: string;
  createdAt: number;
  items: GeneratedAssetDownloadItem[];
}

export interface GeneratedAssetDownloadOffer {
  id: string;
  conversationId: string;
  logicalMessageId: string;
  assetId: string;
  filename: string;
}

export interface GeneratedAssetDownloadClaim extends GeneratedAssetDownloadOffer {
  claimToken: string;
}

export interface GeneratedAssetDownloadSource {
  conversationId: string;
  tab: number;
  documentId: string;
  documentGeneration: number;
  spaEpoch: number;
}

export interface GeneratedAssetDownloadRequest {
  sessionId: string;
  logicalMessageId: string;
  assetIds: string[];
}

export interface GeneratedAssetDownloadResult {
  id: string;
  claimToken: string;
  state: Exclude<GeneratedAssetDownloadState, 'requested'>;
  detail?: string;
}
