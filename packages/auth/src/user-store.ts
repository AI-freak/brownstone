import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentConfig, UserAccount, UserProfile, UserRole } from '@brownstone/contracts';
import { ConflictError, NotFoundError } from '@brownstone/errors';

/**
 * File-backed user store. Reads and writes are serialized through a single
 * mutex to prevent the lost-update problem under concurrent writes (rare
 * given the localhost scope, but the cost is one promise per write).
 */

const USERS_FILENAME = 'users.json';

interface UsersFile {
  version: 1;
  users: UserAccount[];
}

function userFilePath(config: AgentConfig): string {
  return path.join(config.dataDir, 'auth', USERS_FILENAME);
}

async function readFile(config: AgentConfig): Promise<UsersFile> {
  try {
    const raw = await fs.readFile(userFilePath(config), 'utf8');
    const parsed = JSON.parse(raw) as UsersFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.users)) {
      throw new Error('User store has an unexpected shape');
    }
    return parsed;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, users: [] };
    }
    throw error;
  }
}

async function writeFile(config: AgentConfig, data: UsersFile): Promise<void> {
  const filePath = userFilePath(config);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Write to a temp file then rename for atomicity.
  const tmp = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

// Per-config mutex so two callers don't race on read-modify-write.
const writeLocks = new WeakMap<AgentConfig, Promise<unknown>>();

async function withLock<T>(config: AgentConfig, fn: () => Promise<T>): Promise<T> {
  // Chain off the previous lock without caring whether it succeeded.
  // `.then(undefined, () => undefined)` neutralizes upstream rejections so a
  // failed prior operation doesn't poison the queue.
  const previous = writeLocks.get(config) ?? Promise.resolve();
  const gate = previous.then(undefined, () => undefined);
  const next = gate.then(fn);
  // Store a never-rejecting handle so the next caller chains off a clean tail.
  writeLocks.set(config, next.then(undefined, () => undefined));
  return next;
}

export function toProfile(user: UserAccount): UserProfile {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
  };
}

export async function listUsers(config: AgentConfig): Promise<UserProfile[]> {
  const file = await readFile(config);
  return file.users.map(toProfile);
}

export async function findUserById(config: AgentConfig, id: string): Promise<UserAccount | undefined> {
  const file = await readFile(config);
  return file.users.find((user) => user.id === id);
}

export async function findUserByEmail(config: AgentConfig, email: string): Promise<UserAccount | undefined> {
  const normalized = email.trim().toLowerCase();
  const file = await readFile(config);
  return file.users.find((user) => user.email === normalized);
}

export async function createUserRecord(
  config: AgentConfig,
  input: { email: string; displayName: string; passwordHash: string; role: UserRole },
): Promise<UserAccount> {
  return withLock(config, async () => {
    const file = await readFile(config);
    const normalizedEmail = input.email.trim().toLowerCase();
    if (file.users.some((user) => user.email === normalizedEmail)) {
      throw new ConflictError('An account with that email already exists');
    }
    const account: UserAccount = {
      id: `user_${crypto.randomBytes(12).toString('hex')}`,
      email: normalizedEmail,
      displayName: input.displayName.trim() || normalizedEmail.split('@')[0],
      passwordHash: input.passwordHash,
      createdAt: new Date().toISOString(),
      role: input.role,
    };
    file.users.push(account);
    await writeFile(config, file);
    return account;
  });
}

export async function updateUserPassword(
  config: AgentConfig,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await withLock(config, async () => {
    const file = await readFile(config);
    const user = file.users.find((u) => u.id === userId);
    if (!user) throw new NotFoundError('User not found');
    user.passwordHash = passwordHash;
    await writeFile(config, file);
  });
}

/**
 * Count without holding the lock; used to decide whether the next signup
 * should be promoted to admin. The race window doesn't matter — if two users
 * sign up at the exact same first-boot moment, both becoming admin is fine.
 */
export async function countUsers(config: AgentConfig): Promise<number> {
  const file = await readFile(config);
  return file.users.length;
}
