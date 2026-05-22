import type {
  AgentConfig,
  ApprovalRecord,
  ArtifactExportRecord,
  BrowserCaptureResult,
  BrowserSubmitResult,
  CollaborationComment,
  GitDiffResult,
  GitStatusSummary,
  MemoryNote,
  ModelProvider,
  PatchPlan,
  ResearchAnswer,
  ScheduledTask,
  SearchResponse,
  SessionRecord,
  TaskKind,
  TaskRecord,
  TelemetryEvent,
  ThinkingMode,
  Tool,
  ToolCall,
  ToolResult,
  UploadedDocument,
  UserProfile,
} from '@brownstone/contracts';
import type { RuntimeEvent } from '@brownstone/runtime';

/**
 * Capabilities the control plane needs from underlying packages.
 *
 * Defining this as an interface (rather than importing each function directly)
 * gives us three wins:
 *   1. Tests can inject fakes without mocking module imports.
 *   2. We can layer ownership filtering in one place (in `service.ts`).
 *   3. The dependency surface is documented in one file.
 *
 * Every method that creates or queries a resource takes a `UserProfile` so
 * the underlying package can scope storage per-user.
 */
export interface ControlPlaneCapabilities {
  // Provider & runtime
  provider: ModelProvider;
  runTurn(config: AgentConfig, provider: ModelProvider, sessionId: string, prompt: string): Promise<string>;
  /** Streaming runtime entrypoint. */
  runChatTurn(args: {
    config: AgentConfig;
    provider: ModelProvider;
    user: UserProfile;
    sessionId: string;
    prompt: string;
    tools?: Tool[];
  }): { events: AsyncIterable<RuntimeEvent>; final: Promise<{ assistant: string; thinkingText: string; toolCalls: Array<ToolCall & { result?: ToolResult }> }>; cancel(): void };
  /** Built-in tools the runtime should expose. */
  builtinTools?(config: AgentConfig): Tool[];

  // Sessions
  startSession(config: AgentConfig, owner: UserProfile): Promise<SessionRecord>;
  listSessions(config: AgentConfig, owner: UserProfile): Promise<SessionRecord[]>;
  loadSession(config: AgentConfig, sessionId: string): Promise<SessionRecord | undefined>;

  // Tasks
  enqueueTask(config: AgentConfig, owner: UserProfile, kind: TaskKind, input: Record<string, unknown>): Promise<TaskRecord>;
  listTasks(config: AgentConfig): Promise<TaskRecord[]>;
  loadTask(config: AgentConfig, taskId: string): Promise<TaskRecord | undefined>;
  processNextTask(config: AgentConfig): Promise<TaskRecord | undefined>;

  // Telemetry
  tailEvents(config: AgentConfig, n: number): Promise<TelemetryEvent[]>;
  writeEvent(config: AgentConfig, event: TelemetryEvent): Promise<void>;

  // Memory
  listMemory(config: AgentConfig): Promise<MemoryNote[]>;

  // Git
  getGitStatus(config: AgentConfig): Promise<GitStatusSummary>;
  getGitDiff(config: AgentConfig, relativePath?: string): Promise<GitDiffResult>;

  // Patching
  parsePatchPlan(plan: unknown): PatchPlan;
  previewPatchPlan(config: AgentConfig, plan: PatchPlan): Promise<string>;
  applyPatchPlan(config: AgentConfig, plan: PatchPlan): Promise<{ applied: number; files: string[] }>;

  // Browser worker
  browserCapture(config: AgentConfig, req: { url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<BrowserCaptureResult>;
  browserSubmit(config: AgentConfig, req: { url: string; method?: 'POST'; fields: Record<string, string> }, approval?: string): Promise<BrowserSubmitResult>;

  // Search & research
  performWebSearch(config: AgentConfig, query: string): Promise<SearchResponse>;
  answerResearchQuestion(args: {
    config: AgentConfig;
    query: string;
    mode: ThinkingMode;
    fetchPages?: boolean;
    sessionId?: string;
  }): Promise<ResearchAnswer>;

  // Uploads
  saveUploadedText(config: AgentConfig, owner: UserProfile, filename: string, content: string, tags: string[]): Promise<UploadedDocument>;
  listUploadedDocuments(config: AgentConfig): Promise<UploadedDocument[]>;
  retrieveUploadedDocuments(config: AgentConfig, owner: UserProfile, query: string): Promise<Array<{ documentId: string; filename: string; score: number; snippet: string }>>;

  // Schedules
  listSchedules(config: AgentConfig): Promise<ScheduledTask[]>;
  createSchedule(config: AgentConfig, owner: UserProfile, input: { title: string; prompt: string; everyMs: number; thinkingMode: ThinkingMode }): Promise<ScheduledTask>;

  // Collaboration
  addComment(config: AgentConfig, input: { targetId: string; authorUserId: string; authorDisplayName: string; text: string }): Promise<CollaborationComment>;
  listComments(config: AgentConfig, targetId?: string): Promise<CollaborationComment[]>;
  listApprovals(config: AgentConfig, targetId?: string): Promise<ApprovalRecord[]>;
  recordApproval(config: AgentConfig, input: { targetId: string; actorUserId: string; actorDisplayName: string; action: 'approved' | 'rejected'; note?: string }): Promise<ApprovalRecord>;

  // Exports
  listExports(config: AgentConfig): Promise<ArtifactExportRecord[]>;
  createExportBundle(config: AgentConfig, owner: UserProfile, input: { title: string; session?: SessionRecord; tasks: TaskRecord[]; summary: string }): Promise<ArtifactExportRecord>;
}
