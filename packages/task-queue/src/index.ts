import path from 'node:path';
import type { AgentConfig, TaskKind, TaskRecord, UserProfile } from '@brownstone/contracts';
import { NotFoundError } from '@brownstone/errors';
import { generateId, readJsonFile, updateJsonFile } from '@brownstone/storage';

/**
 * Persistent task queue.
 *
 * Single JSON file at {dataDir}/tasks/queue.json. Atomic writes via the
 * shared storage mutex prevent lost updates. The queue isn't sharded
 * because this is single-host by design — if you need scale, swap this
 * package for a Redis-backed one with the same exports.
 *
 * Status state machine:
 *   queued → running → (succeeded | failed | cancelled)
 *
 * Attempts is bumped on each run; the executor can use it for retry/backoff.
 */

interface QueueFile {
  version: 1;
  tasks: TaskRecord[];
}

const EMPTY: QueueFile = { version: 1, tasks: [] };

function queuePath(config: AgentConfig): string {
  return path.join(config.dataDir, 'tasks', 'queue.json');
}

export async function enqueueTask(
  config: AgentConfig,
  owner: UserProfile,
  kind: TaskKind,
  input: Record<string, unknown>,
): Promise<TaskRecord> {
  const now = new Date().toISOString();
  const task: TaskRecord = {
    id: generateId('task'),
    ownerUserId: owner.id,
    kind,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    input,
  };
  await updateJsonFile<QueueFile>(queuePath(config), EMPTY, (file) => ({
    ...file,
    tasks: [...file.tasks, task],
  }));
  return task;
}

export async function listTasks(config: AgentConfig): Promise<TaskRecord[]> {
  const file = await readJsonFile<QueueFile>(queuePath(config), EMPTY);
  return file.tasks.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadTask(config: AgentConfig, taskId: string): Promise<TaskRecord | undefined> {
  const file = await readJsonFile<QueueFile>(queuePath(config), EMPTY);
  return file.tasks.find((task) => task.id === taskId);
}

/**
 * Atomic claim — pick the oldest queued task, mark it running, return it.
 * Returns undefined if the queue is empty.
 */
export async function claimNextTask(config: AgentConfig): Promise<TaskRecord | undefined> {
  let claimed: TaskRecord | undefined;
  await updateJsonFile<QueueFile>(queuePath(config), EMPTY, (file) => {
    const queued = file.tasks.find((task) => task.status === 'queued');
    if (!queued) return file;
    queued.status = 'running';
    queued.attempts += 1;
    queued.updatedAt = new Date().toISOString();
    claimed = queued;
    return file;
  });
  return claimed;
}

export async function completeTask(
  config: AgentConfig,
  taskId: string,
  outcome: { status: 'succeeded' | 'failed' | 'cancelled'; result?: Record<string, unknown>; error?: string },
): Promise<TaskRecord> {
  let updated: TaskRecord | undefined;
  await updateJsonFile<QueueFile>(queuePath(config), EMPTY, (file) => {
    const task = file.tasks.find((t) => t.id === taskId);
    if (!task) throw new NotFoundError(`Task ${taskId} not found`);
    task.status = outcome.status;
    task.result = outcome.result;
    task.error = outcome.error;
    task.updatedAt = new Date().toISOString();
    updated = task;
    return file;
  });
  if (!updated) throw new NotFoundError(`Task ${taskId} not found`);
  return updated;
}
