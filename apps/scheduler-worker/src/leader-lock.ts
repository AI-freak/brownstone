import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentConfig } from '@brownstone/contracts';

/**
 * File-based advisory leader lock.
 *
 * Not a true distributed lock — this is a single-host system. The intent is
 * just to catch the easy mistake of starting the scheduler twice. We write
 * our PID into the lock file and, on startup, check whether the prior PID
 * is still alive. If it is, we back off.
 */

const LOCK_FILENAME = 'scheduler.lock';

function lockPath(config: AgentConfig): string {
  return path.join(config.dataDir, 'locks', LOCK_FILENAME);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function acquireLeaderLock(config: AgentConfig): Promise<boolean> {
  const file = lockPath(config);
  await fs.mkdir(path.dirname(file), { recursive: true });

  try {
    const raw = await fs.readFile(file, 'utf8');
    const existingPid = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(existingPid) && existingPid !== process.pid && isProcessAlive(existingPid)) {
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  await fs.writeFile(file, String(process.pid), 'utf8');
  return true;
}

export async function releaseLeaderLock(config: AgentConfig): Promise<void> {
  await fs.unlink(lockPath(config)).catch(() => undefined);
}
