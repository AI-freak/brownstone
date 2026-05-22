import crypto from 'node:crypto';
import type { AgentConfig } from '@brownstone/contracts';
import { ForbiddenError } from '@brownstone/errors';

/**
 * Per-session double-submit CSRF: the cookie-authenticated client must echo
 * a CSRF token (derived deterministically from the session ID + secret) in
 * an `x-brownstone-csrf` header on mutating requests. Because cookies aren't
 * sent on cross-origin requests with SameSite=Strict, this is belt-and-braces
 * — but it costs ~nothing and stops the proxy approval-token leak from #1.
 */

export function deriveCsrfToken(config: AgentConfig, sessionId: string): string {
  return crypto.createHmac('sha256', config.authSecret).update(`csrf:${sessionId}`).digest('base64url');
}

export function assertCsrfToken(config: AgentConfig, sessionId: string, provided: string | undefined): void {
  if (!provided) {
    throw new ForbiddenError('Missing CSRF token');
  }
  const expected = deriveCsrfToken(config, sessionId);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ForbiddenError('CSRF token did not verify');
  }
}
