import type { AgentConfig } from '@brownstone/contracts';
import { ForbiddenError, TimeoutError } from '@brownstone/errors';

const LOCALHOST_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0']);

/**
 * Refuse to start a server bound to a non-loopback interface unless the
 * operator has explicitly set BROWNSTONE_ALLOW_PUBLIC_BIND=true. This is
 * intentionally an environment escape hatch rather than a config field so
 * it has to be a deliberate `export` to override.
 */
export function assertLocalhostBinding(host: string): void {
  if (LOCALHOST_HOSTS.has(host)) return;
  if (process.env.BROWNSTONE_ALLOW_PUBLIC_BIND === 'true') return;
  throw new ForbiddenError(
    `Refusing to bind to non-loopback host "${host}". ` +
    'Set BROWNSTONE_ALLOW_PUBLIC_BIND=true to override (only do this behind a trusted reverse proxy).',
  );
}

// --- Approval gates ---------------------------------------------------------

export function assertActionApproved(label: string, providedApproval: string | undefined, config: AgentConfig): void {
  if (!config.requireApprovalForWrites) return;
  const expected = config.approvalToken?.trim();
  if (!expected) {
    throw new ForbiddenError(`${label} requires explicit approval, but no approval token is configured on the server`);
  }
  if (!providedApproval || providedApproval !== expected) {
    throw new ForbiddenError(`${label} requires a valid approval token`);
  }
}

export function assertExternalActionApproved(label: string, providedApproval: string | undefined, config: AgentConfig): void {
  if (!config.requireApprovalForExternalActions) return;
  const expected = config.approvalToken?.trim();
  if (!expected) {
    throw new ForbiddenError(`${label} requires explicit approval, but no approval token is configured on the server`);
  }
  if (!providedApproval || providedApproval !== expected) {
    throw new ForbiddenError(`${label} requires a valid approval token`);
  }
}

// --- Workspace read gate ----------------------------------------------------

import { assertWithin, safeResolve } from './paths.js';
export { assertWithin, safeResolve };

export function assertReadable(absolutePath: string, config: AgentConfig): void {
  assertWithin(config.workspaceRoot, absolutePath, 'Workspace read');
}

// --- Timeout wrapper --------------------------------------------------------

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
