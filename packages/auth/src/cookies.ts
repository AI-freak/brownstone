import crypto from 'node:crypto';
import type { AgentConfig } from '@brownstone/contracts';
import { UnauthenticatedError } from '@brownstone/errors';

/**
 * Cookie sessions are HMAC-signed payloads, not opaque IDs into a server
 * table. Trade-off:
 *   + No storage cost, no DB round trip per request.
 *   + Survives server restarts as long as authSecret persists.
 *   - Cannot be revoked individually before expiry (acceptable for this scope;
 *     a revocation list could be added later as a thin overlay).
 *
 * Format: <base64url(payload)>.<base64url(hmac)>
 * Payload is JSON: { sid, uid, iat, exp }
 */

interface SignedPayload {
  sid: string;
  uid: string;
  iat: number;
  exp: number;
}

function b64urlEncode(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function b64urlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function sign(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueSessionCookie(config: AgentConfig, userId: string): { value: string; expiresAt: Date } {
  const now = Date.now();
  const payload: SignedPayload = {
    sid: crypto.randomBytes(16).toString('hex'),
    uid: userId,
    iat: now,
    exp: now + config.sessionTtlMs,
  };
  const encoded = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const signature = sign(config.authSecret, encoded);
  return {
    value: `${encoded}.${signature}`,
    expiresAt: new Date(payload.exp),
  };
}

export function verifySessionCookie(config: AgentConfig, raw: string): SignedPayload {
  if (typeof raw !== 'string' || !raw.includes('.')) {
    throw new UnauthenticatedError('Invalid session cookie');
  }
  const [encoded, signature] = raw.split('.', 2);
  if (!encoded || !signature) {
    throw new UnauthenticatedError('Invalid session cookie');
  }
  const expected = sign(config.authSecret, encoded);
  // Constant-time comparison
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new UnauthenticatedError('Session signature did not verify');
  }
  let payload: SignedPayload;
  try {
    payload = JSON.parse(b64urlDecode(encoded).toString('utf8')) as SignedPayload;
  } catch {
    throw new UnauthenticatedError('Session payload is malformed');
  }
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) {
    throw new UnauthenticatedError('Session has expired');
  }
  if (typeof payload.uid !== 'string' || typeof payload.sid !== 'string') {
    throw new UnauthenticatedError('Session payload is missing required fields');
  }
  return payload;
}

// --- Cookie header parsing/emitting ----------------------------------------

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    // Decode percent-encoding; ignore malformed
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function buildSessionCookieHeader(
  name: string,
  value: string,
  options: { maxAgeSeconds: number; secure: boolean },
): string {
  const segments = [
    `${name}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${options.maxAgeSeconds}`,
    'Path=/',
  ];
  if (options.secure) segments.push('Secure');
  return segments.join('; ');
}

export function buildClearCookieHeader(name: string, secure: boolean): string {
  const segments = [
    `${name}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    'Path=/',
  ];
  if (secure) segments.push('Secure');
  return segments.join('; ');
}
