import fs from 'node:fs/promises';
import path from 'node:path';
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
  PatchPlan,
  ResearchAnswer,
  ScheduledTask,
  SearchResponse,
  SessionRecord,
  TaskKind,
  TaskRecord,
  TelemetryEvent,
  ThinkingMode,
  UploadedDocument,
  UserProfile,
  WorkspaceNode,
} from '@brownstone/contracts';
import { ForbiddenError, NotFoundError } from '@brownstone/errors';
import {
  assertActionApproved,
  assertExternalActionApproved,
  assertReadable,
  safeResolve,
  withTimeout,
} from '@brownstone/security';
import type { ControlPlaneCapabilities } from './capabilities.js';
import { assertOwner, filterOwned } from './middleware/ownership.js';

/**
 * Detect a MIME type from an extension. Conservative on purpose — anything
 * unknown becomes plain text rather than e.g. application/octet-stream, which
 * keeps the workspace-read route safe to send inline.
 */
function detectMimeType(relativePath: string): string {
  const extension = path.extname(relativePath).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.cjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  return map[extension] ?? 'text/plain; charset=utf-8';
}

async function readWorkspaceTextFile(workspaceRoot: string, relativePath: string): Promise<string> {
  const target = safeResolve(workspaceRoot, relativePath, 'Workspace read');
  return fs.readFile(target, 'utf8');
}

/** Build a tree of workspace files up to `depth` levels. */
async function buildWorkspaceTree(workspaceRoot: string, relativePath: string, depth: number): Promise<WorkspaceNode[]> {
  const target = safeResolve(workspaceRoot, relativePath, 'Workspace tree');
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    // Permission errors and unexpected failures should propagate so the
    // caller can see them in telemetry.
    throw error;
  }
  const sorted = entries
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

  const nodes: WorkspaceNode[] = [];
  for (const entry of sorted) {
    const childRelative = path.posix.join(relativePath.replace(/\\/g, '/'), entry.name);
    const node: WorkspaceNode = {
      name: entry.name,
      relativePath: childRelative.replace(/^\.\//, ''),
      type: entry.isDirectory() ? 'dir' : 'file',
    };
    if (entry.isDirectory() && depth > 1) {
      node.children = await buildWorkspaceTree(workspaceRoot, node.relativePath, depth - 1);
    }
    nodes.push(node);
  }
  return nodes;
}

// ---------------------------------------------------------------------------

export interface ControlPlaneService {
  // Public-but-authenticated
  health(): Promise<Record<string, unknown>>;
  whoami(user: UserProfile): UserProfile;

  // Sessions
  listSessions(user: UserProfile): Promise<SessionRecord[]>;
  createSession(user: UserProfile): Promise<SessionRecord>;
  getSession(user: UserProfile, sessionId: string): Promise<SessionRecord>;

  // Chat (non-streaming, for backwards compat)
  chat(user: UserProfile, sessionId: string, prompt: string): Promise<{ ok: true; answer: string }>;

  // Chat (streaming) - writes Server-Sent Events to the response directly.
  chatStream(user: UserProfile, sessionId: string, prompt: string, res: import('node:http').ServerResponse): Promise<void>;

  // Git
  gitStatus(user: UserProfile): Promise<GitStatusSummary>;
  gitDiff(user: UserProfile, relativePath?: string): Promise<GitDiffResult>;

  // Patches
  patchPreview(user: UserProfile, plan: unknown): Promise<{ ok: true; preview: string }>;
  patchApply(user: UserProfile, plan: unknown, providedApproval?: string): Promise<{ ok: true; result: { applied: number; files: string[] } }>;

  // Tasks
  listTasks(user: UserProfile): Promise<TaskRecord[]>;
  createTask(user: UserProfile, kind: TaskKind, input: Record<string, unknown>): Promise<TaskRecord>;
  processNextTask(user: UserProfile): Promise<{ ok: true; idle: boolean; task: TaskRecord | null }>;
  getTask(user: UserProfile, taskId: string): Promise<TaskRecord>;

  // Telemetry
  telemetry(user: UserProfile): Promise<TelemetryEvent[]>;

  // Browser
  browserCapture(user: UserProfile, url: string): Promise<BrowserCaptureResult>;
  browserSubmit(user: UserProfile, url: string, fields: Record<string, string>, providedApproval?: string): Promise<BrowserSubmitResult>;

  // Search / research
  searchWeb(user: UserProfile, query: string): Promise<SearchResponse>;
  researchAnswer(user: UserProfile, query: string, mode?: ThinkingMode, options?: { fetchPages?: boolean; sessionId?: string }): Promise<ResearchAnswer>;

  // Uploads
  uploadText(user: UserProfile, filename: string, content: string, tags?: string[]): Promise<UploadedDocument>;
  listUploads(user: UserProfile): Promise<UploadedDocument[]>;
  retrieveUploads(user: UserProfile, query: string): Promise<Array<{ documentId: string; filename: string; score: number; snippet: string }>>;

  // Schedules
  listSchedules(user: UserProfile): Promise<ScheduledTask[]>;
  createSchedule(user: UserProfile, input: { title: string; prompt: string; everyMs: number; thinkingMode: ThinkingMode }): Promise<ScheduledTask>;

  // Collaboration
  addComment(user: UserProfile, targetId: string, text: string): Promise<CollaborationComment>;
  listComments(user: UserProfile, targetId?: string): Promise<CollaborationComment[]>;
  listApprovals(user: UserProfile, targetId?: string): Promise<ApprovalRecord[]>;

  // Exports
  createExport(user: UserProfile, title: string, sessionId?: string): Promise<ArtifactExportRecord>;
  listExports(user: UserProfile): Promise<ArtifactExportRecord[]>;

  // Workspace
  workspaceTree(user: UserProfile, relativePath?: string, depth?: number): Promise<{ root: string; entries: WorkspaceNode[] }>;
  readWorkspaceFile(user: UserProfile, relativePath: string): Promise<{ relativePath: string; content: string; mimeType: string }>;
  readArtifactFile(user: UserProfile, relativePath: string): Promise<{ relativePath: string; content: string; mimeType: string }>;

  // Memory
  listMemory(user: UserProfile): Promise<MemoryNote[]>;
}

export function createControlPlaneService(
  config: AgentConfig,
  capabilities: ControlPlaneCapabilities,
): ControlPlaneService {
  const cap = capabilities;

  // Helper: load a session, then assert the caller owns it.
  async function loadOwnedSession(user: UserProfile, sessionId: string): Promise<SessionRecord> {
    const session = await cap.loadSession(config, sessionId);
    assertOwner(session, user, 'Session');
    return session;
  }

  async function loadOwnedTask(user: UserProfile, taskId: string): Promise<TaskRecord> {
    const task = await cap.loadTask(config, taskId);
    assertOwner(task, user, 'Task');
    return task;
  }

  return {
    async health() {
      return {
        ok: true,
        mode: config.permissionMode,
        providerMode: config.providerMode,
        host: config.serverHost,
        port: config.serverPort,
        workspaceRoot: config.workspaceRoot,
        approvalRequired: config.requireApprovalForWrites,
        externalApprovalRequired: config.requireApprovalForExternalActions,
        maxToolSteps: config.maxToolSteps,
        maxTaskRuntimeMs: config.maxTaskRuntimeMs,
        browserAllowlist: config.browserAllowlist,
        defaultThinkingMode: config.defaultThinkingMode,
        searchProviderMode: config.searchProviderMode,
        allowRegistration: config.allowRegistration,
      };
    },

    whoami(user) {
      return user;
    },

    // -- Sessions -------------------------------------------------------
    async listSessions(user) {
      const all = await cap.listSessions(config, user);
      return filterOwned(all, user);
    },
    async createSession(user) {
      return cap.startSession(config, user);
    },
    async getSession(user, sessionId) {
      return loadOwnedSession(user, sessionId);
    },

    // -- Chat -----------------------------------------------------------
    async chat(user, sessionId, prompt) {
      await loadOwnedSession(user, sessionId);
      const answer = await withTimeout(
        cap.runTurn(config, cap.provider, sessionId, prompt),
        config.maxTaskRuntimeMs,
        'Chat turn',
      );
      return { ok: true as const, answer };
    },

    async chatStream(user, sessionId, prompt, res) {
      await loadOwnedSession(user, sessionId);
      // Set up SSE response headers
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no'); // disable proxy buffering
      res.flushHeaders?.();

      const stream = cap.runChatTurn({
        config, provider: cap.provider, user, sessionId, prompt,
        tools: cap.builtinTools ? cap.builtinTools(config) : [],
      });

      // Forward each runtime event as an SSE message.
      try {
        for await (const event of stream.events) {
          if (res.writableEnded) {
            stream.cancel();
            break;
          }
          res.write(`event: ${event.type}\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      } catch (error) {
        if (!res.writableEnded) {
          res.write(`event: error\n`);
          res.write(`data: ${JSON.stringify({ type: 'error', message: (error as Error).message, recoverable: false })}\n\n`);
        }
      } finally {
        if (!res.writableEnded) {
          res.write(`event: stream_end\n`);
          res.write(`data: ${JSON.stringify({ type: 'stream_end' })}\n\n`);
          res.end();
        }
      }
    },

    // -- Git ------------------------------------------------------------
    async gitStatus(_user) { return cap.getGitStatus(config); },
    async gitDiff(_user, relativePath) { return cap.getGitDiff(config, relativePath); },

    // -- Patches --------------------------------------------------------
    async patchPreview(_user, plan) {
      const parsed = cap.parsePatchPlan(plan);
      return { ok: true as const, preview: await cap.previewPatchPlan(config, parsed) };
    },
    async patchApply(user, plan, providedApproval) {
      const parsed = cap.parsePatchPlan(plan);
      assertActionApproved('Patch apply', providedApproval, config);
      const result = await cap.applyPatchPlan(config, parsed);
      await cap.writeEvent(config, {
        timestamp: new Date().toISOString(),
        type: 'file_write_applied',
        userId: user.id,
        payload: { files: result.files, count: result.applied },
      });
      return { ok: true as const, result };
    },

    // -- Tasks ----------------------------------------------------------
    async listTasks(user) {
      const all = await cap.listTasks(config);
      return filterOwned(all, user);
    },
    async createTask(user, kind, input) {
      return cap.enqueueTask(config, user, kind, input);
    },
    async processNextTask(user) {
      // Admins can drive the queue; members can't pop tasks belonging to others.
      if (user.role !== 'admin') {
        throw new ForbiddenError('Only admins can advance the global task queue');
      }
      const task = await withTimeout(cap.processNextTask(config), config.maxTaskRuntimeMs, 'Task processing');
      return { ok: true as const, idle: !task, task: task ?? null };
    },
    async getTask(user, taskId) { return loadOwnedTask(user, taskId); },

    // -- Telemetry ------------------------------------------------------
    async telemetry(user) {
      const events = await cap.tailEvents(config, 200);
      if (user.role === 'admin') return events;
      return events.filter((event) => event.userId === undefined || event.userId === user.id);
    },

    // -- Browser --------------------------------------------------------
    async browserCapture(_user, url) {
      return withTimeout(cap.browserCapture(config, { url, waitUntil: 'load' }), config.maxTaskRuntimeMs, 'Browser capture');
    },
    async browserSubmit(_user, url, fieldsObj, providedApproval) {
      assertExternalActionApproved('External form submission', providedApproval, config);
      return withTimeout(
        cap.browserSubmit(config, { url, method: 'POST', fields: fieldsObj }, providedApproval),
        config.maxTaskRuntimeMs,
        'Browser submit',
      );
    },

    // -- Search / research ---------------------------------------------
    async searchWeb(_user, query) { return cap.performWebSearch(config, query); },
    async researchAnswer(user, query, mode = config.defaultThinkingMode, options = {}) {
      if (options.sessionId) await loadOwnedSession(user, options.sessionId);
      return cap.answerResearchQuestion({
        config, query, mode,
        fetchPages: options.fetchPages ?? true,
        sessionId: options.sessionId,
      });
    },

    // -- Uploads --------------------------------------------------------
    async uploadText(user, filename, content, tags = []) {
      return cap.saveUploadedText(config, user, filename, content, tags);
    },
    async listUploads(user) {
      const all = await cap.listUploadedDocuments(config);
      return filterOwned(all, user);
    },
    async retrieveUploads(user, query) {
      return cap.retrieveUploadedDocuments(config, user, query);
    },

    // -- Schedules ------------------------------------------------------
    async listSchedules(user) {
      const all = await cap.listSchedules(config);
      return filterOwned(all, user);
    },
    async createSchedule(user, input) {
      return cap.createSchedule(config, user, input);
    },

    // -- Collaboration --------------------------------------------------
    async addComment(user, targetId, text) {
      return cap.addComment(config, {
        targetId,
        authorUserId: user.id,
        authorDisplayName: user.displayName,
        text,
      });
    },
    async listComments(_user, targetId) {
      return cap.listComments(config, targetId);
    },
    async listApprovals(_user, targetId) {
      return cap.listApprovals(config, targetId);
    },

    // -- Exports --------------------------------------------------------
    async createExport(user, title, sessionId) {
      const session = sessionId ? await loadOwnedSession(user, sessionId) : undefined;
      const tasks = await cap.listTasks(config).then((all) => filterOwned(all, user));
      return cap.createExportBundle(config, user, {
        title,
        session,
        tasks,
        summary: session?.turns.at(-1)?.assistant ?? 'Workspace export',
      });
    },
    async listExports(user) {
      const all = await cap.listExports(config);
      return filterOwned(all, user);
    },

    // -- Workspace ------------------------------------------------------
    async workspaceTree(_user, relativePath = '.', depth = 2) {
      return {
        root: config.workspaceRoot,
        entries: await buildWorkspaceTree(config.workspaceRoot, relativePath, depth),
      };
    },
    async readWorkspaceFile(_user, relativePath) {
      const target = safeResolve(config.workspaceRoot, relativePath, 'Workspace read');
      assertReadable(target, config);
      return {
        relativePath,
        content: await readWorkspaceTextFile(config.workspaceRoot, relativePath),
        mimeType: detectMimeType(relativePath),
      };
    },
    async readArtifactFile(_user, relativePath) {
      const target = safeResolve(config.dataDir, relativePath, 'Artifact read');
      try {
        return {
          relativePath,
          content: await fs.readFile(target, 'utf8'),
          mimeType: detectMimeType(relativePath),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new NotFoundError('Artifact not found');
        }
        throw error;
      }
    },

    // -- Memory ---------------------------------------------------------
    async listMemory(user) {
      const all = await cap.listMemory(config);
      return filterOwned(all, user);
    },
  };
}
