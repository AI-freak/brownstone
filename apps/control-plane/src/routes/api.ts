import type { AgentConfig, AuthContext, TaskKind, ThinkingMode } from '@brownstone/contracts';
import { InternalError } from '@brownstone/errors';
import { fields, queryFields, sendText, type RouteDefinition, type RequestContext } from '@brownstone/http-kit';
import type { ControlPlaneService } from '../service.js';

const TASK_KINDS = ['chat_turn', 'browser_capture', 'workspace_index', 'orchestration_plan', 'web_search'] as const;
const THINKING_MODES = ['quick', 'balanced', 'deep'] as const;

/**
 * Pull the auth context the server's auth middleware attached to ctx.locals.
 * If auth is missing here, the dispatcher has a bug — throw a 500 not a 401,
 * because by the time we reach a private route the gate has already passed.
 */
function getAuth(ctx: RequestContext): AuthContext {
  const auth = ctx.locals.auth as AuthContext | undefined;
  if (!auth) throw new InternalError('Auth middleware did not attach auth context');
  return auth;
}

function readApprovalHeader(ctx: RequestContext): string | undefined {
  const value = ctx.req.headers['x-brownstone-approval'];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

function coerceStringMap(input: unknown): Record<string, string> {
  if (input === null || typeof input !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    result[key] = String(value);
  }
  return result;
}

export function buildApiRoutes(config: AgentConfig, service: ControlPlaneService): RouteDefinition[] {
  return [
    // -- Health (public) ---------------------------------------------------
    {
      method: 'GET', path: '/health', publicRoute: true, csrf: false,
      handler: () => service.health(),
    },

    // -- Sessions ----------------------------------------------------------
    { method: 'GET',  path: '/sessions',     handler: (ctx) => service.listSessions(getAuth(ctx).user) },
    { method: 'POST', path: '/sessions',     handler: (ctx) => service.createSession(getAuth(ctx).user) },
    { method: 'GET',  path: '/sessions/:id', handler: (ctx) => service.getSession(getAuth(ctx).user, ctx.params.id) },

    // -- Chat (non-streaming, for backwards compat) -----------------------
    {
      method: 'POST', path: '/chat',
      handler: (ctx) => {
        const f = fields(ctx.body);
        return service.chat(getAuth(ctx).user, f.string('sessionId'), f.string('prompt'));
      },
    },

    // -- Chat streaming (Server-Sent Events) ------------------------------
    // The handler writes the response itself and returns undefined to signal
    // the dispatcher not to wrap as JSON.
    {
      method: 'POST', path: '/chat/stream',
      handler: async (ctx) => {
        const f = fields(ctx.body);
        const sessionId = f.string('sessionId');
        const prompt = f.string('prompt');
        await service.chatStream(getAuth(ctx).user, sessionId, prompt, ctx.res);
        return undefined;
      },
    },

    // -- Git ---------------------------------------------------------------
    { method: 'GET', path: '/git/status', handler: (ctx) => service.gitStatus(getAuth(ctx).user) },
    {
      method: 'GET', path: '/git/diff',
      handler: (ctx) => service.gitDiff(getAuth(ctx).user, queryFields(ctx.url.searchParams).optionalString('path')),
    },

    // -- Patches -----------------------------------------------------------
    {
      method: 'POST', path: '/patch/preview',
      handler: (ctx) => service.patchPreview(getAuth(ctx).user, fields(ctx.body).raw('plan')),
    },
    {
      method: 'POST', path: '/patch/apply',
      handler: (ctx) => service.patchApply(getAuth(ctx).user, fields(ctx.body).raw('plan'), readApprovalHeader(ctx)),
    },

    // -- Tasks -------------------------------------------------------------
    { method: 'GET',  path: '/tasks',              handler: (ctx) => service.listTasks(getAuth(ctx).user) },
    { method: 'POST', path: '/tasks/process-next', handler: (ctx) => service.processNextTask(getAuth(ctx).user) },
    {
      method: 'POST', path: '/tasks',
      handler: (ctx) => {
        const f = fields(ctx.body);
        return service.createTask(
          getAuth(ctx).user,
          f.enum<TaskKind>('kind', TASK_KINDS),
          f.optionalObject('input') ?? {},
        );
      },
    },
    { method: 'GET', path: '/tasks/:id', handler: (ctx) => service.getTask(getAuth(ctx).user, ctx.params.id) },

    // -- Telemetry ---------------------------------------------------------
    { method: 'GET', path: '/telemetry', handler: (ctx) => service.telemetry(getAuth(ctx).user) },

    // -- Browser -----------------------------------------------------------
    {
      method: 'POST', path: '/browser/capture',
      handler: (ctx) => service.browserCapture(getAuth(ctx).user, fields(ctx.body).string('url')),
    },
    {
      method: 'POST', path: '/browser/submit',
      handler: (ctx) => {
        const f = fields(ctx.body);
        return service.browserSubmit(
          getAuth(ctx).user,
          f.string('url'),
          coerceStringMap(f.optionalObject('fields')),
          readApprovalHeader(ctx),
        );
      },
    },

    // -- Search / research -------------------------------------------------
    {
      method: 'POST', path: '/search/web',
      handler: (ctx) => service.searchWeb(getAuth(ctx).user, fields(ctx.body).string('query')),
    },
    {
      method: 'POST', path: '/research/answer',
      handler: (ctx) => {
        const f = fields(ctx.body);
        return service.researchAnswer(
          getAuth(ctx).user,
          f.string('query'),
          f.optionalEnum<ThinkingMode>('mode', THINKING_MODES) ?? config.defaultThinkingMode,
          {
            fetchPages: f.optionalBoolean('fetchPages', true),
            sessionId: f.optionalString('sessionId'),
          },
        );
      },
    },

    // -- Uploads -----------------------------------------------------------
    {
      method: 'POST', path: '/uploads/text',
      handler: (ctx) => {
        const f = fields(ctx.body);
        const hasTags = Array.isArray((ctx.body as Record<string, unknown>).tags);
        return service.uploadText(
          getAuth(ctx).user,
          f.string('filename'),
          f.string('content'),
          hasTags ? f.stringArray('tags') : [],
        );
      },
    },
    { method: 'GET', path: '/uploads', handler: (ctx) => service.listUploads(getAuth(ctx).user) },
    {
      method: 'POST', path: '/uploads/retrieve',
      handler: (ctx) => service.retrieveUploads(getAuth(ctx).user, fields(ctx.body).string('query')),
    },

    // -- Schedules ---------------------------------------------------------
    { method: 'GET', path: '/schedules', handler: (ctx) => service.listSchedules(getAuth(ctx).user) },
    {
      method: 'POST', path: '/schedules',
      handler: (ctx) => {
        const f = fields(ctx.body);
        return service.createSchedule(getAuth(ctx).user, {
          title: f.string('title'),
          prompt: f.string('prompt'),
          everyMs: f.number('everyMs'),
          thinkingMode: f.optionalEnum<ThinkingMode>('thinkingMode', THINKING_MODES) ?? config.defaultThinkingMode,
        });
      },
    },

    // -- Collaboration -----------------------------------------------------
    {
      method: 'GET', path: '/collaboration/comments',
      handler: (ctx) => service.listComments(getAuth(ctx).user, queryFields(ctx.url.searchParams).optionalString('targetId')),
    },
    {
      method: 'POST', path: '/collaboration/comments',
      handler: (ctx) => {
        const f = fields(ctx.body);
        return service.addComment(getAuth(ctx).user, f.string('targetId'), f.string('text'));
      },
    },
    {
      method: 'GET', path: '/collaboration/approvals',
      handler: (ctx) => service.listApprovals(getAuth(ctx).user, queryFields(ctx.url.searchParams).optionalString('targetId')),
    },

    // -- Exports -----------------------------------------------------------
    { method: 'GET', path: '/exports', handler: (ctx) => service.listExports(getAuth(ctx).user) },
    {
      method: 'POST', path: '/exports/session',
      handler: (ctx) => {
        const f = fields(ctx.body);
        return service.createExport(
          getAuth(ctx).user,
          f.optionalString('title') ?? 'Brownstone Export',
          f.optionalString('sessionId'),
        );
      },
    },

    // -- Workspace ---------------------------------------------------------
    {
      method: 'GET', path: '/workspace/tree',
      handler: (ctx) => {
        const q = queryFields(ctx.url.searchParams);
        return service.workspaceTree(getAuth(ctx).user, q.optionalString('path') ?? '.', q.optionalInt('depth', 2));
      },
    },
    {
      method: 'GET', path: '/workspace/file',
      handler: (ctx) => service.readWorkspaceFile(getAuth(ctx).user, queryFields(ctx.url.searchParams).string('path')),
    },
    {
      method: 'GET', path: '/workspace/raw',
      handler: async (ctx) => {
        const file = await service.readWorkspaceFile(getAuth(ctx).user, queryFields(ctx.url.searchParams).string('path'));
        sendText(ctx.res, 200, file.content, file.mimeType);
        return undefined;
      },
    },

    // -- Artifacts ---------------------------------------------------------
    {
      method: 'GET', path: '/artifacts/file',
      handler: (ctx) => service.readArtifactFile(getAuth(ctx).user, queryFields(ctx.url.searchParams).string('path')),
    },
    {
      method: 'GET', path: '/artifacts/raw',
      handler: async (ctx) => {
        const file = await service.readArtifactFile(getAuth(ctx).user, queryFields(ctx.url.searchParams).string('path'));
        sendText(ctx.res, 200, file.content, file.mimeType);
        return undefined;
      },
    },

    // -- Memory ------------------------------------------------------------
    { method: 'GET', path: '/memory', handler: (ctx) => service.listMemory(getAuth(ctx).user) },
  ];
}
