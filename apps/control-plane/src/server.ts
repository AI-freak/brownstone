import http from 'node:http';
import { URL } from 'node:url';
import type { AgentConfig } from '@brownstone/contracts';
import { ForbiddenError, InternalError, UnauthenticatedError } from '@brownstone/errors';
import { assertCsrfToken } from '@brownstone/auth';
import {
  Router,
  readJsonBody,
  send404,
  sendError,
  sendJson,
  installGracefulShutdown,
  type RouteDefinition,
} from '@brownstone/http-kit';
import { assertLocalhostBinding } from '@brownstone/security';
import type { ControlPlaneCapabilities } from './capabilities.js';
import { decodeAuth } from './middleware/auth.js';
import { buildApiRoutes } from './routes/api.js';
import { buildAuthRoutes } from './routes/auth.js';
import { createControlPlaneService } from './service.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface StartedHttpServer {
  host: string;
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}

export function createControlPlaneHttpServer(
  config: AgentConfig,
  capabilities: ControlPlaneCapabilities,
): http.Server {
  assertLocalhostBinding(config.serverHost);
  const service = createControlPlaneService(config, capabilities);

  const router = new Router()
    .addMany(buildAuthRoutes(config))
    .addMany(buildApiRoutes(config, service));

  return http.createServer((req, res) => {
    handleRequest(req, res, config, router).catch((error) => {
      sendError(res, new InternalError('Unhandled request error', { cause: error }), console.error);
    });
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: AgentConfig,
  router: Router,
): Promise<void> {
  try {
    const method = req.method ?? 'GET';
    const hostHeader = req.headers.host ?? `${config.serverHost}:${config.serverPort}`;
    const url = new URL(req.url ?? '/', `http://${hostHeader}`);
    const match = router.match(method, url.pathname);

    if (!match) {
      send404(res, method, url.pathname);
      return;
    }

    const { route, params } = match;
    const locals: Record<string, unknown> = {};

    // -- Auth gate -----------------------------------------------------
    let userSessionId: string | undefined;
    if (!route.publicRoute) {
      const auth = await decodeAuth(req, config); // throws 401 if missing
      locals.auth = auth;
      userSessionId = auth.sessionId;
    }

    // -- CSRF gate -----------------------------------------------------
    // CSRF applies to mutating routes that are not explicitly opted out
    // (login/register can't have a CSRF token yet — they bootstrap the cookie).
    const csrfRequired = route.csrf ?? (!route.publicRoute && MUTATING_METHODS.has(route.method));
    if (csrfRequired) {
      // Bearer-token auth (CLI, VS Code) doesn't need CSRF because there's no
      // implicit credential the browser will send for them.
      const authHeader = String(req.headers.authorization ?? '');
      const bearerAuth = authHeader.startsWith('Bearer ');
      if (!bearerAuth) {
        if (!userSessionId) {
          throw new UnauthenticatedError('Session required for CSRF-protected route');
        }
        const provided = oneHeader(req.headers['x-brownstone-csrf']);
        assertCsrfToken(config, userSessionId, provided);
      }
    }

    // -- Read body for non-GET methods --------------------------------
    const body = method === 'GET' || method === 'HEAD' ? {} : await readJsonBody(req);

    // -- Dispatch -----------------------------------------------------
    const result = await route.handler({ req, res, params, url, body, locals });
    if (result !== undefined && !res.writableEnded) {
      sendJson(res, 200, result);
    }
  } catch (error) {
    if (!res.writableEnded) sendError(res, error, console.error);
  }
}

function oneHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

// ---------------------------------------------------------------------------

export interface StartOptions {
  config: AgentConfig;
  capabilities: ControlPlaneCapabilities;
  host?: string;
  port?: number;
  /** Pass false in tests where multiple servers boot in one process. */
  installSignalHandlers?: boolean;
}

export async function startControlPlaneServer(options: StartOptions): Promise<StartedHttpServer> {
  const config = options.config;
  if (options.host) config.serverHost = options.host;
  if (options.port !== undefined) config.serverPort = options.port;

  const server = createControlPlaneHttpServer(config, options.capabilities);
  installGracefulShutdown(server, {
    timeoutMs: 10_000,
    onShutdown: (signal) => console.log(`Control plane received ${signal}, draining…`),
    installSignalHandlers: options.installSignalHandlers,
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.serverPort, config.serverHost, () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.serverPort;

  return {
    host: config.serverHost,
    port,
    baseUrl: `http://${config.serverHost}:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      // Close keep-alive sockets so .close() resolves promptly. Without
      // these, fetch clients holding open connections would block shutdown
      // until they time out (~5s for the integration test's 14 servers =
      // 70s, which is why the suite timed out).
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
