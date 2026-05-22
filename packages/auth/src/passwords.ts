import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { AgentConfig } from '@brownstone/contracts';
import { ValidationError } from '@brownstone/errors';

/**
 * Password hashing with Node's built-in scrypt.
 *
 * Why not bcrypt? Bcrypt requires native compilation, which makes install
 * brittle across Node versions and OSes. scrypt is RFC 7914 and ships in
 * Node core — same memory-hardness properties, no install pain.
 *
 * Format: `scrypt:<saltHex>:<keyHex>$<N>:<r>:<p>`
 *   - salt: 16 random bytes
 *   - key:  64 bytes derived
 *   - N r p: scrypt parameters
 *
 * The config field is still called `bcryptRounds` for env-var continuity:
 * each round maps to a doubling of N (rounds=12 → N=4096, comparable in
 * latency to bcrypt rounds=12). Clamped to [4, 15].
 */

const scryptAsync = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLEL = 1;

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;

export function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new ValidationError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
}

function costFromRounds(rounds: number): number {
  const clamped = Math.max(4, Math.min(15, Math.floor(rounds)));
  return 2 ** clamped;
}

export async function hashPassword(config: AgentConfig, password: string): Promise<string> {
  validatePassword(password);
  const N = costFromRounds(config.bcryptRounds);
  const salt = crypto.randomBytes(SALT_BYTES);
  const maxmem = Math.max(32 * 1024 * 1024, 128 * N * SCRYPT_BLOCK_SIZE * 2);
  const derived = (await scryptAsync(password, salt, KEY_LENGTH, {
    N, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLEL, maxmem,
  })) as Buffer;
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}$${N}:${SCRYPT_BLOCK_SIZE}:${SCRYPT_PARALLEL}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    if (!hash.startsWith('scrypt:')) return false;
    const [payload, paramsPart] = hash.split('$', 2);
    if (!paramsPart) return false;
    const [saltHex, keyHex] = payload.slice('scrypt:'.length).split(':', 2);
    const [Nstr, rStr, pStr] = paramsPart.split(':', 3);
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    const N = Number.parseInt(Nstr, 10);
    const r = Number.parseInt(rStr, 10);
    const p = Number.parseInt(pStr, 10);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    const maxmem = Math.max(32 * 1024 * 1024, 128 * N * r * 2);
    const derived = (await scryptAsync(password, salt, expected.length, { N, r, p, maxmem })) as Buffer;
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
