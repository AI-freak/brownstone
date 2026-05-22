import http from 'node:http';
import { URL } from 'node:url';
import type { AgentConfig } from '@brownstone/contracts';
import { InternalError } from '@brownstone/errors';
import {
  Router,
  fields,
  readJsonBody,
  send404,
  sendError,
  sendJson,
  installGracefulShutdown,
} from '@brownstone/http-kit';
import { assertExternalActionApproved, assertLocalhostBinding } from '@brownstone/security';

/**
 * Browser worker is a separate process holding the only handle to the
 * headless browser. It is reachable only on a loopback interface and never
 * accepts unsigned external-action calls without the approval token.
 *
 * Auth is intentionally absent here — the worker isn't multi-tenant; the
 * control plane is the single allowed caller. The control plane's bearer
 * token is forwarded as `x-brownstone-approval` for mutating actions.
 */

// Minimal local types for the browser driver. The real package provides these,
// but for this rewrite the worker only depends on the surface it actually uses.
interface BrowserDriver {
  capture(req: { url: string; waitUntil: 'load' }, config: AgentConfig): Promise<unknown>;
  submit(req: { url: string; method: 'POST'; fields: Record<string, string> }, config: AgentConfig): Promise<unknown>;
}

export interface StartedHttpServer {
  host: string;
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}

function readApproval(req: http.IncomingMessage): string | undefined {
  const value = req.headers['x-brownstone-approval'];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

function coerceStringMap(input: unknown): Record<string, string> {
  if (input === null || typeof input !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    result[key] = String(value);
  }
  return result;
}

export function createBrowserWorkerHttpServer(config: AgentConfig, driver: BrowserDriver): http.Server {
  assertLocalhostBinding(config.browserHost);

  const router = new Router()
    .add({
      method: 'GET',
      path: '/health',
      publicRoute: true,
      handler: () => ({
        ok: true,
        host: config.browserHost,
        port: config.browserPort,
        allowlist: config.browserAllowlist,
        requiresExternalApproval: config.requireApprovalForExternalActions,
      }),
    })
    .add({
      method: 'POST',
      path: '/capture',
      publicRoute: true,
      handler: async ({ body }) => driver.capture(
        { url: fields(body).string('url'), waitUntil: 'load' },
        config,
      ),
    })
    .add({
      method: 'POST',
      path: '/submit',
      publicRoute: true,
      handler: async ({ req, body }) => {
        assertExternalActionApproved('External form submission', readApproval(req), config);
        const f = fields(body);
        return driver.submit({
          url: f.string('url'),
          method: 'POST',
          fields: coerceStringMap(f.optionalObject('fields')),
        }, config);
      },
    });

  return http.createServer((req, res) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const hostHeader = req.headers.host ?? `${config.browserHost}:${config.browserPort}`;
        const url = new URL(req.url ?? '/', `http://${hostHeader}`);
        const match = router.match(method, url.pathname);

        if (!match) {
          send404(res, method, url.pathname);
          return;
        }

        const body = method === 'GET' || method === 'HEAD' ? {} : await readJsonBody(req);
        const result = await match.route.handler({ req, res, params: match.params, url, body });
        if (result !== undefined && !res.writableEnded) {
          sendJson(res, 200, result);
        }
      } catch (error) {
        sendError(res, new InternalError('Browser worker request failed', { cause: error }), console.error);
      }
    })();
  });
}

export interface StartOptions {
  config: AgentConfig;
  driver: BrowserDriver;
  host?: string;
  port?: number;
}

export async function startBrowserWorkerServer(options: StartOptions): Promise<StartedHttpServer> {
  const config = options.config;
  if (options.host) config.browserHost = options.host;
  if (options.port !== undefined) config.browserPort = options.port;

  const server = createBrowserWorkerHttpServer(config, options.driver);
  installGracefulShutdown(server, {
    timeoutMs: 10_000,
    onShutdown: (signal) => console.log(`Browser worker received ${signal}, draining…`),
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.browserPort, config.browserHost, () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.browserPort;

  return {
    host: config.browserHost,
    port,
    baseUrl: `http://${config.browserHost}:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
