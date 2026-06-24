export type ClassSessionMaterialKind = 'pdf' | 'image' | 'document' | 'slides' | 'link' | 'file';
export type ClassSessionMaterialSource = 'upload' | 'link';

export interface ClassSessionMaterial {
  id: string;
  materialId: string;
  sessionId: string;
  batchId: string;
  roomId?: string;
  title: string;
  description?: string;
  kind: ClassSessionMaterialKind;
  source: ClassSessionMaterialSource;
  fileName?: string;
  mimeType?: string;
  size?: number;
  storageProvider?: 'local' | 's3';
  downloadUrl?: string;
  url?: string;
  shared: boolean;
  sharedAt?: string;
  sharedByUserId?: string;
  uploadedByUserId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface CreateClassSessionMaterialLinkRequest {
  batchId?: string;
  title: string;
  url: string;
  description?: string;
  kind?: Extract<ClassSessionMaterialKind, 'link' | 'document' | 'slides' | 'file'>;
}

export interface ClassSessionMaterialShareRequest {
  batchId?: string;
}

export interface ClassSessionMaterialEvent {
  sessionId: string;
  batchId: string;
  roomId: string;
  materialId?: string;
  material?: ClassSessionMaterial;
  shared: boolean;
  actorUserId?: string;
  createdAt: string;
}
