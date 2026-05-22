import type { OwnedResource } from './auth.js';

export interface CollaborationComment {
  id: string;
  createdAt: string;
  targetId: string;
  authorUserId: string;
  authorDisplayName: string;
  text: string;
}

export interface ApprovalRecord {
  id: string;
  createdAt: string;
  targetId: string;
  action: 'approved' | 'rejected';
  actorUserId: string;
  actorDisplayName: string;
  note?: string;
}

export interface ArtifactExportRecord extends OwnedResource {
  id: string;
  createdAt: string;
  title: string;
  htmlPath?: string;
  markdownPath?: string;
  jsonPath?: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  localEntry: string;
  requestedPermissions: Array<'read' | 'write' | 'shell' | 'browser'>;
}
