import crypto from 'node:crypto';
import path from 'node:path';
import type {
  AgentConfig,
  PermissionMode,
  PluginApprovalMode,
  ProviderMode,
  SearchProviderMode,
  ThinkingMode,
} from '@brownstone/contracts';
import { ValidationError } from '@brownstone/errors';

/**
 * .env loading note: we no longer parse .env in-process. Use Node 20.6+'s
 * `--env-file=.env` flag at process start, or a process manager. This removes
 * a buggy custom parser (no multi-line, no escape handling) and one source of
 * mystery behavior in tests.
 *
 * Example:
 *   node --env-file=.env dist/index.js
 */

const DEFAULT_SHELL_ALLOWLIST = ['git', 'npm', 'node', 'npx', 'pnpm', 'yarn', 'ls', 'pwd', 'cat', 'echo'];

// --- Parse helpers with validation ------------------------------------------

function readString(key: string, fallback: string): string {
  const value = process.env[key];
  return value !== undefined && value !== '' ? value : fallback;
}

function readOptionalString(key: string): string | undefined {
  const value = process.env[key];
  return value !== undefined && value !== '' ? value : undefined;
}

function readInt(key: string, fallback: number, opts: { min?: number; max?: number } = {}): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`Environment variable ${key} must be an integer, got "${raw}"`);
  }
  if (opts.min !== undefined && parsed < opts.min) {
    throw new ValidationError(`Environment variable ${key} must be >= ${opts.min}`);
  }
  if (opts.max !== undefined && parsed > opts.max) {
    throw new ValidationError(`Environment variable ${key} must be <= ${opts.max}`);
  }
  return parsed;
}

function readBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new ValidationError(`Environment variable ${key} must be a boolean, got "${raw}"`);
}

function readCsv(key: string, fallback: string[] = []): string[] {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = raw.split(',').map((item) => item.trim()).filter(Boolean);
  return parsed.length ? parsed : fallback;
}

// --- Enum resolvers ---------------------------------------------------------

export function resolvePermissionMode(value?: string): PermissionMode {
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') {
    return value;
  }
  return 'read-only';
}

function resolveApprovalMode(value?: string): PluginApprovalMode {
  return value === 'manual' || value === 'disabled' ? value : 'manual';
}

function resolveProviderMode(value: string | undefined, hasApiKey: boolean): ProviderMode {
  if (value === 'local-sim' || value === 'openai-compatible') return value;
  return hasApiKey ? 'openai-compatible' : 'local-sim';
}

function resolveThinkingMode(value?: string): ThinkingMode {
  return value === 'quick' || value === 'balanced' || value === 'deep' ? value : 'balanced';
}

function resolveSearchProviderMode(value: string | undefined, hasKey: boolean): SearchProviderMode {
  if (value === 'disabled' || value === 'brave') return value;
  return hasKey ? 'brave' : 'disabled';
}

// --- Auth secret ------------------------------------------------------------

/**
 * In dev, generate a random secret per boot if none is provided. This means
 * cookies don't persist across restarts (deliberate — forces real deployments
 * to set BROWNSTONE_AUTH_SECRET) but doesn't crash the server.
 */
function resolveAuthSecret(): { secret: string; ephemeral: boolean } {
  const explicit = readOptionalString('BROWNSTONE_AUTH_SECRET');
  if (explicit && explicit.length >= 32) return { secret: explicit, ephemeral: false };
  if (explicit) {
    throw new ValidationError('BROWNSTONE_AUTH_SECRET must be at least 32 characters');
  }
  return { secret: crypto.randomBytes(48).toString('base64url'), ephemeral: true };
}

// --- Public API -------------------------------------------------------------

export function loadConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const workspaceRoot = path.resolve(overrides.workspaceRoot ?? readString('BROWNSTONE_WORKSPACE', '.'));
  const dataDir = path.resolve(overrides.dataDir ?? readString('BROWNSTONE_DATA_DIR', '.brownstone-platform'));
  const openAiApiKey = overrides.openAiApiKey ?? readOptionalString('OPENAI_API_KEY');
  const serverHost = overrides.serverHost ?? readString('BROWNSTONE_SERVER_HOST', '127.0.0.1');
  const serverPort = overrides.serverPort ?? readInt('BROWNSTONE_SERVER_PORT', 8787, { min: 0, max: 65535 });
  const braveSearchApiKey = overrides.braveSearchApiKey ?? readOptionalString('BRAVE_SEARCH_API_KEY');
  const { secret: authSecret } = resolveAuthSecret();

  return {
    workspaceRoot,
    dataDir,

    permissionMode: overrides.permissionMode ?? resolvePermissionMode(process.env.BROWNSTONE_MODE),
    enableShellTool: overrides.enableShellTool ?? readBool('BROWNSTONE_ENABLE_SHELL', false),
    requireApprovalForWrites: overrides.requireApprovalForWrites ?? readBool('BROWNSTONE_REQUIRE_APPROVALS', false),
    requireApprovalForExternalActions: overrides.requireApprovalForExternalActions ?? readBool('BROWNSTONE_REQUIRE_EXTERNAL_APPROVALS', true),
    approvalToken: overrides.approvalToken ?? readOptionalString('BROWNSTONE_APPROVAL_TOKEN'),
    shellCommandAllowlist: overrides.shellCommandAllowlist ?? readCsv('BROWNSTONE_SHELL_ALLOWLIST', DEFAULT_SHELL_ALLOWLIST),

    model: overrides.model ?? readString('BROWNSTONE_MODEL', 'gpt-4.1-mini'),
    providerMode: overrides.providerMode ?? resolveProviderMode(process.env.BROWNSTONE_PROVIDER_MODE, Boolean(openAiApiKey)),
    openAiApiKey,
    openAiBaseUrl: overrides.openAiBaseUrl ?? readString('OPENAI_BASE_URL', 'https://api.openai.com/v1'),

    serverHost,
    serverPort,
    controlPlaneBaseUrl: overrides.controlPlaneBaseUrl ?? readString('BROWNSTONE_CONTROL_PLANE_URL', `http://${serverHost}:${serverPort}`),
    controlPlaneToken: overrides.controlPlaneToken ?? readOptionalString('BROWNSTONE_CONTROL_PLANE_TOKEN'),
    browserHost: overrides.browserHost ?? readString('BROWNSTONE_BROWSER_HOST', '127.0.0.1'),
    browserPort: overrides.browserPort ?? readInt('BROWNSTONE_BROWSER_PORT', 8788, { min: 0, max: 65535 }),
    webHost: overrides.webHost ?? readString('BROWNSTONE_WEB_HOST', '127.0.0.1'),
    webPort: overrides.webPort ?? readInt('BROWNSTONE_WEB_PORT', 8791, { min: 0, max: 65535 }),

    authSecret: overrides.authSecret ?? authSecret,
    authCookieName: overrides.authCookieName ?? readString('BROWNSTONE_AUTH_COOKIE', '__sa_session'),
    sessionTtlMs: overrides.sessionTtlMs ?? readInt('BROWNSTONE_SESSION_TTL_MS', 7 * 24 * 60 * 60 * 1000, { min: 60_000 }),
    bcryptRounds: overrides.bcryptRounds ?? readInt('BROWNSTONE_BCRYPT_ROUNDS', 12, { min: 4, max: 15 }),
    allowRegistration: overrides.allowRegistration ?? readBool('BROWNSTONE_ALLOW_REGISTRATION', true),

    browserAllowlist: overrides.browserAllowlist ?? readCsv('BROWNSTONE_BROWSER_ALLOWLIST'),
    maxBrowserActionsPerTask: overrides.maxBrowserActionsPerTask ?? readInt('BROWNSTONE_MAX_BROWSER_ACTIONS', 3, { min: 0 }),

    taskPollMs: overrides.taskPollMs ?? readInt('BROWNSTONE_TASK_POLL_MS', 1500, { min: 100 }),
    maxToolSteps: overrides.maxToolSteps ?? readInt('BROWNSTONE_MAX_TOOL_STEPS', 4, { min: 1 }),
    maxTaskRuntimeMs: overrides.maxTaskRuntimeMs ?? readInt('BROWNSTONE_MAX_TASK_RUNTIME_MS', 90_000, { min: 1000 }),

    searchProviderMode: overrides.searchProviderMode ?? resolveSearchProviderMode(process.env.BROWNSTONE_SEARCH_PROVIDER, Boolean(braveSearchApiKey)),
    braveSearchApiKey,
    maxSearchResults: overrides.maxSearchResults ?? readInt('BROWNSTONE_MAX_SEARCH_RESULTS', 5, { min: 1 }),
    maxFetchedPagesPerResearch: overrides.maxFetchedPagesPerResearch ?? readInt('BROWNSTONE_MAX_FETCHED_PAGES', 3, { min: 0 }),

    pluginApproval: overrides.pluginApproval ?? resolveApprovalMode(process.env.BROWNSTONE_PLUGIN_APPROVAL),
    uploadMaxBytes: overrides.uploadMaxBytes ?? readInt('BROWNSTONE_UPLOAD_MAX_BYTES', 1024 * 1024, { min: 1024 }),

    defaultThinkingMode: overrides.defaultThinkingMode ?? resolveThinkingMode(process.env.BROWNSTONE_THINKING_MODE),
    schedulerTickMs: overrides.schedulerTickMs ?? readInt('BROWNSTONE_SCHEDULER_TICK_MS', 30_000, { min: 1000 }),
  };
}
