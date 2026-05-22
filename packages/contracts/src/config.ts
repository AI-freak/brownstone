export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type PluginApprovalMode = 'manual' | 'disabled';
export type ProviderMode = 'openai-compatible' | 'local-sim';
export type ThinkingMode = 'quick' | 'balanced' | 'deep';
export type SearchProviderMode = 'disabled' | 'brave';

/**
 * Full runtime configuration. Loaded once at process start; pass through
 * function arguments rather than reading from a global so tests can override.
 */
export interface AgentConfig {
  // Filesystem
  workspaceRoot: string;
  dataDir: string;

  // Security gates
  permissionMode: PermissionMode;
  enableShellTool: boolean;
  requireApprovalForWrites: boolean;
  requireApprovalForExternalActions: boolean;
  approvalToken?: string;
  shellCommandAllowlist: string[];

  // Provider
  model: string;
  providerMode: ProviderMode;
  openAiApiKey?: string;
  openAiBaseUrl: string;

  // HTTP topology
  serverHost: string;
  serverPort: number;
  controlPlaneBaseUrl: string;
  controlPlaneToken?: string;
  browserHost: string;
  browserPort: number;
  webHost: string;
  webPort: number;

  // Multi-user auth
  authSecret: string;
  authCookieName: string;
  sessionTtlMs: number;
  bcryptRounds: number;
  allowRegistration: boolean;

  // Browser worker
  browserAllowlist: string[];
  maxBrowserActionsPerTask: number;

  // Task processing
  taskPollMs: number;
  maxToolSteps: number;
  maxTaskRuntimeMs: number;

  // Search / research
  searchProviderMode: SearchProviderMode;
  braveSearchApiKey?: string;
  maxSearchResults: number;
  maxFetchedPagesPerResearch: number;

  // Plugins / uploads
  pluginApproval: PluginApprovalMode;
  uploadMaxBytes: number;

  // Misc
  defaultThinkingMode: ThinkingMode;
  schedulerTickMs: number;
}
