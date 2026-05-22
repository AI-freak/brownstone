import fs from 'node:fs/promises';
import type { AgentConfig, Tool, ToolContext, ToolResult } from '@brownstone/contracts';
import { safeResolve } from '@brownstone/security';
import { createWebSearchProvider, performWebSearch } from '@brownstone/web-search';
import { getGitStatus } from '@brownstone/git-tools';

/**
 * Built-in tools.
 *
 * Each tool has a stable name, an inputSchema (used by the provider for
 * function calling), and a run() that takes the parsed input and returns a
 * ToolResult. Failures are returned as `{ok: false, content: errorMessage}`
 * rather than thrown, so the model sees the error and can recover.
 *
 * Three tools to start, covering the categories that motivated tool calling
 * in the first place:
 *   - workspace_read: read a file from the user's workspace
 *   - web_search: search the web (uses the configured provider)
 *   - git_status: summarize the git working tree
 *
 * Adding more is a matter of writing one function per tool — no
 * registration ceremony.
 */

export function builtinTools(_config: AgentConfig): Tool[] {
  return [
    workspaceReadTool,
    webSearchTool,
    gitStatusTool,
  ];
}

// ---- workspace_read ------------------------------------------------------

const workspaceReadTool: Tool = {
  definition: {
    name: 'workspace_read',
    description: 'Read the contents of a text file from the user\'s workspace. Returns up to 8000 characters; use this when the user references a file by path.',
    inputSchema: {
      type: 'object',
      required: ['relativePath'],
      properties: {
        relativePath: {
          type: 'string',
          description: 'Path relative to the workspace root, e.g. "src/index.ts".',
        },
      },
      additionalProperties: false,
    },
  },
  async run(input, context: ToolContext): Promise<ToolResult> {
    const relativePath = String((input as { relativePath?: unknown }).relativePath ?? '').trim();
    if (!relativePath) {
      return { ok: false, content: 'workspace_read requires a non-empty relativePath' };
    }
    try {
      const target = safeResolve(context.config.workspaceRoot, relativePath, 'workspace_read');
      const stat = await fs.stat(target);
      if (!stat.isFile()) {
        return { ok: false, content: `${relativePath} is not a regular file` };
      }
      if (stat.size > 1024 * 1024) {
        return { ok: false, content: `${relativePath} is larger than 1 MiB (${stat.size} bytes); refusing` };
      }
      const text = await fs.readFile(target, 'utf8');
      const truncated = text.length > 8000;
      const preview = truncated ? text.slice(0, 8000) + '\n…[truncated]' : text;
      return {
        ok: true,
        content: preview,
        metadata: { bytes: stat.size, truncated, path: relativePath },
      };
    } catch (error) {
      return { ok: false, content: (error as Error).message };
    }
  },
};

// ---- web_search ----------------------------------------------------------

const webSearchTool: Tool = {
  definition: {
    name: 'web_search',
    description: 'Search the web for information. Returns the top results as a JSON list. Useful for current events, factual lookups, and finding documentation.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural-language search query.' },
      },
      additionalProperties: false,
    },
  },
  async run(input, context: ToolContext): Promise<ToolResult> {
    const query = String((input as { query?: unknown }).query ?? '').trim();
    if (!query) return { ok: false, content: 'web_search requires a non-empty query' };
    try {
      const provider = createWebSearchProvider(context.config);
      const result = await performWebSearch(context.config, query, provider);
      if (result.provider === 'disabled') {
        return {
          ok: false,
          content: 'Web search is disabled on this server. Set BROWNSTONE_SEARCH_PROVIDER=brave and BRAVE_SEARCH_API_KEY to enable.',
        };
      }
      return {
        ok: true,
        content: JSON.stringify({
          query: result.query,
          provider: result.provider,
          results: result.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })),
        }, null, 2),
        metadata: { provider: result.provider, count: result.results.length },
      };
    } catch (error) {
      return { ok: false, content: (error as Error).message };
    }
  },
};

// ---- git_status ----------------------------------------------------------

const gitStatusTool: Tool = {
  definition: {
    name: 'git_status',
    description: 'Summarize the git working tree. Returns the current branch and lists of modified/added/deleted/untracked files.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  async run(_input, context: ToolContext): Promise<ToolResult> {
    try {
      const summary = await getGitStatus(context.config);
      return {
        ok: true,
        content: JSON.stringify(summary, null, 2),
        metadata: {
          branch: summary.branch,
          totalChanges:
            summary.modified.length + summary.added.length + summary.deleted.length + summary.untracked.length,
        },
      };
    } catch (error) {
      return { ok: false, content: (error as Error).message };
    }
  },
};
