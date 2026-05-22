import path from 'node:path';
import { ForbiddenError } from '@brownstone/errors';

/**
 * Defense-in-depth path containment.
 *
 * The original code used `target.startsWith(publicDir)`, which fails when
 * `publicDir = /app/public` and an attacker constructs a path resolving to
 * `/app/public-secret/file.txt` — the prefix check passes.
 *
 * `path.relative` gives the canonical answer: if the resolved target is
 * inside the root, the relative path will not start with `..` and will not
 * be absolute (which can happen on Windows when drives differ).
 */
export function assertWithin(root: string, target: string, label = 'path'): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ForbiddenError(`${label} is outside the allowed root`);
  }
}

/** Resolve `relativePath` against `root` and verify it stays inside. */
export function safeResolve(root: string, relativePath: string, label = 'path'): string {
  const target = path.resolve(root, relativePath);
  assertWithin(root, target, label);
  return target;
}
