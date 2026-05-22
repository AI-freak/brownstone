import type http from 'node:http';
import { URL } from 'node:url';
import { NotFoundError, PayloadTooLargeError, ValidationError, toAppError } from '@brownstone/errors';

/**
 * Tiny declarative router with typed path params.
 *
 * Replaces the previous ~60-line if-chain in server.ts which was order-
 * dependent (`/tasks/process-next` had to be matched before `/tasks/:id`)
 * and used pathname.startsWith() in ways that were fragile to reorder.
 *
 * Routes are matched in registration order; first match wins. Use exact
 * paths for collection endpoints and `:param` segments for items.
 */

export interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  url: URL;
  body: unknown;
  /** Bag for middleware (e.g. auth) to attach data for downstream handlers. */
  locals: Record<string, unknown>;
}

export type RouteHandler = (ctx: RequestContext) => Promise<unknown> | unknown;

export interface RouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Pattern like `/sessions/:id` or `/tasks`. No trailing slash. */
  path: string;
  handler: RouteHandler;
  /** Set to true to skip auth middleware for this route (e.g. /health, /auth/login). */
  publicRoute?: boolean;
  /** Whether this route requires CSRF on top of auth. Defaults to true for mutating verbs. */
  csrf?: boolean;
}

interface CompiledRoute extends RouteDefinition {
  segments: Array<{ kind: 'literal'; value: string } | { kind: 'param'; name: string }>;
}

function compile(route: RouteDefinition): CompiledRoute {
  const parts = route.path.split('/').filter(Boolean);
  return {
    ...route,
    segments: parts.map((part) => part.startsWith(':')
      ? { kind: 'param', name: part.slice(1) }
      : { kind: 'literal', value: part }),
  };
}

export class Router {
  private readonly routes: CompiledRoute[] = [];

  add(route: RouteDefinition): this {
    this.routes.push(compile(route));
    return this;
  }

  addMany(routes: RouteDefinition[]): this {
    for (const route of routes) this.add(route);
    return this;
  }

  match(method: string, pathname: string): { route: CompiledRoute; params: Record<string, string> } | undefined {
    const requestParts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== requestParts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i];
        const part = decodeURIComponent(requestParts[i]);
        if (segment.kind === 'literal') {
          if (segment.value !== part) { matched = false; break; }
        } else {
          params[segment.name] = part;
        }
      }
      if (matched) return { route, params };
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------

export const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;

export async function readJsonBody(req: http.IncomingMessage, maxBytes = DEFAULT_MAX_JSON_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new PayloadTooLargeError(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('Request body is not valid JSON');
  }
}

export function sendJson(res: http.ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  for (const [key, value] of Object.entries(extraHeaders)) {
    res.setHeader(key, value);
  }
  res.end(body);
}

export function sendText(res: http.ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

export function send404(res: http.ServerResponse, method: string, pathname: string): void {
  sendJson(res, 404, new NotFoundError(`Route not found: ${method} ${pathname}`).toJSON());
}

/** Convert a thrown value into a JSON HTTP response. */
export function sendError(res: http.ServerResponse, error: unknown, logger?: (e: unknown) => void): void {
  const app = toAppError(error);
  if (app.statusCode >= 500 && logger) logger(error);
  sendJson(res, app.statusCode, app.toJSON());
}
