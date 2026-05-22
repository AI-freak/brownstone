import type { AgentConfig, TaskRecord } from '@brownstone/contracts';
import { claimNextTask, completeTask } from '@brownstone/task-queue';
import { writeEvent } from '@brownstone/telemetry';

/**
 * Task executor — the worker side of the queue.
 *
 * Pulls the next queued task, runs the corresponding handler, and records
 * the outcome. The kind-to-handler map is tiny on purpose:
 *   - chat_turn: schedule a chat-turn for asynchronous processing
 *   - browser_capture: capture a URL
 *   - workspace_index: build a workspace tree
 *   - orchestration_plan: multi-step plan (stubbed)
 *   - web_search: run a search query
 *
 * Each handler is a thin pass-through to the matching package; the executor
 * keeps the failure-handling logic in one place.
 */

export async function processNextTask(config: AgentConfig): Promise<TaskRecord | undefined> {
  const task = await claimNextTask(config);
  if (!task) return undefined;

  const startedAt = Date.now();
  try {
    const result = await runHandler(task, config);
    const completed = await completeTask(config, task.id, { status: 'succeeded', result });
    await writeEvent(config, {
      timestamp: new Date().toISOString(),
      type: 'task_succeeded',
      userId: task.ownerUserId,
      payload: { taskId: task.id, kind: task.kind, durationMs: Date.now() - startedAt },
    });
    return completed;
  } catch (error) {
    const message = (error as Error).message;
    const completed = await completeTask(config, task.id, { status: 'failed', error: message });
    await writeEvent(config, {
      timestamp: new Date().toISOString(),
      type: 'task_failed',
      userId: task.ownerUserId,
      payload: { taskId: task.id, kind: task.kind, error: message },
    });
    return completed;
  }
}

async function runHandler(task: TaskRecord, config: AgentConfig): Promise<Record<string, unknown>> {
  switch (task.kind) {
    case 'browser_capture': {
      const { requestBrowserCapture } = await import('@brownstone/browser-automation');
      const url = String(task.input.url ?? '');
      const result = await requestBrowserCapture(config, { url, waitUntil: 'load' });
      return { result };
    }
    case 'web_search': {
      const { createWebSearchProvider, performWebSearch } = await import('@brownstone/web-search');
      const provider = createWebSearchProvider(config);
      const result = await performWebSearch(config, String(task.input.query ?? ''), provider);
      return { result };
    }
    case 'workspace_index': {
      // Stub: capture the queue input so the result can be inspected.
      return { result: { ok: true, kind: 'workspace_index', input: task.input } };
    }
    case 'orchestration_plan': {
      // Stub for now — real implementation in Pass 3.
      return { result: { ok: true, kind: 'orchestration_plan', message: 'stubbed' } };
    }
    case 'chat_turn': {
      // Async chat turns aren't fully supported yet (would need a session id
      // and user context that's safe to use without an HTTP request); for
      // Pass 2 we record the input and mark as no-op.
      return { result: { ok: true, kind: 'chat_turn', message: 'enqueued chat turns are recorded but not executed in Pass 2' } };
    }
    default:
      throw new Error(`No handler for task kind: ${(task as TaskRecord).kind}`);
  }
}
