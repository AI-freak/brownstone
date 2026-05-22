import type http from 'node:http';
import type { AgentConfig, AuthContext } from '@brownstone/contracts';
import { UnauthenticatedError } from '@brownstone/errors';
import { loadUserProfile, parseCookies, verifySessionCookie } from '@brownstone/auth';

/**
 * Decode the auth state of an incoming request. Two acceptable forms:
 *
 *   1. Cookie: cookie-name=<signed-payload>  (used by the browser UI)
 *   2. Bearer: Authorization: Bearer <signed-payload>  (used by CLI/VS Code)
 *
 * Either way, the payload format is identical — both routes go through
 * `verifySessionCookie`. This means the CLI and VS Code never persist a
 * raw password and can hold a token issued by /auth/login the same way the
 * web UI does.
 *
 * Throws UnauthenticatedError when no valid token is present so the route
 * handler can decide whether to require auth (most routes) or fall through
 * (e.g. /health, /auth/login).
 */
export async function decodeAuth(req: http.IncomingMessage, config: AgentConfig): Promise<AuthContext> {
  const token = extractToken(req, config);
  if (!token) {
    throw new UnauthenticatedError('Authentication required');
  }
  const payload = verifySessionCookie(config, token);
  const user = await loadUserProfile(config, payload.uid);
  return { user, sessionId: payload.sid };
}

export async function tryDecodeAuth(req: http.IncomingMessage, config: AgentConfig): Promise<AuthContext | undefined> {
  try {
    return await decodeAuth(req, config);
  } catch {
    return undefined;
  }
}

function extractToken(req: http.IncomingMessage, config: AgentConfig): string | undefined {
  // Prefer Authorization header so an API client never confuses with a stale cookie.
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const value = authHeader.slice('Bearer '.length).trim();
    if (value) return value;
  }
  const cookies = parseCookies(req.headers.cookie);
  return cookies[config.authCookieName];
}
