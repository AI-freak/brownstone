export interface PatchOperation {
  type: 'replace_file' | 'append_file' | 'delete_file';
  relativePath: string;
  content?: string;
}

export interface PatchPlan {
  summary: string;
  operations: PatchOperation[];
}

export interface GitStatusSummary {
  branch: string;
  aheadBehind?: string;
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
}

export interface GitDiffResult {
  relativePath?: string;
  diff: string;
}

export interface WorkspaceNode {
  name: string;
  relativePath: string;
  type: 'file' | 'dir';
  children?: WorkspaceNode[];
}
