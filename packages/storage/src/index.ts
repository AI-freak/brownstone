import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Shared file-backed JSON store primitives.
 *
 * Every package in the runtime uses files on disk as its source of truth
 * (no SQL, no Redis). This module centralizes atomic writes (temp file +
 * rename), directory creation, and a per-path mutex so concurrent updates
 * don't lose writes.
 *
 * It's all in @brownstone/storage so each domain package can stay focused
 * on its records, not its IO.
 */

const writeLocks = new Map<string, Promise<unknown>>();

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(filePath) ?? Promise.resolve();
  const gate = previous.then(undefined, () => undefined);
  const next = gate.then(fn);
  writeLocks.set(filePath, next.then(undefined, () => undefined));
  try {
    return await next;
  } finally {
    // Allow GC of completed locks for filepaths no longer being written.
    // Best-effort: only clear if our promise is still the head.
    if (writeLocks.get(filePath) && (await Promise.resolve(writeLocks.get(filePath))) === undefined) {
      writeLocks.delete(filePath);
    }
  }
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  await withFileLock(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, filePath);
  });
}

/**
 * Read-modify-write under a per-file lock. The mutator gets the current
 * value (or `fallback` if no file exists) and returns the new value.
 */
export async function updateJsonFile<T>(
  filePath: string,
  fallback: T,
  mutator: (current: T) => T | Promise<T>,
): Promise<T> {
  return withFileLock(filePath, async () => {
    const current = await readJsonFile(filePath, fallback);
    const next = await mutator(current);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fs.rename(tmp, filePath);
    return next;
  });
}

export async function appendJsonl<T>(filePath: string, entry: T): Promise<void> {
  await withFileLock(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
  });
}

export async function readJsonlTail<T>(filePath: string, maxLines: number): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const lines = raw.split('\n').filter(Boolean);
  const tail = lines.slice(-maxLines);
  const out: T[] = [];
  for (const line of tail) {
    try { out.push(JSON.parse(line) as T); }
    catch { /* skip malformed entries */ }
  }
  return out;
}

/** Generate a short, URL-safe random id with a label prefix. */
export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}
