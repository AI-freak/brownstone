import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@brownstone/config';
import { assertLocalhostBinding, assertWithin } from '@brownstone/security';
import { installGracefulShutdown } from '@brownstone/http-kit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

/**
 * Header allowlist for browser → control-plane forwarding.
 *
 * The approval header is forwarded only when the request carries
 * authentication credentials. The control plane re-validates auth on its
 * side anyway, so this is defense in depth: it stops anonymous traffic
 * from even reaching the approval gate.
 */
const FORWARDED_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'authorization',
  'content-type',
  'cookie',
  'x-brownstone-csrf',
]);

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.mjs':  'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
  };
  return map[ext] ?? 'text/plain; charset=utf-8';
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
  const relative = pathname === '/' ? '/index.html' : pathname;
  const target = path.resolve(PUBLIC_DIR, `.${relative}`);
  try {
    assertWithin(PUBLIC_DIR, target, 'static asset');
  } catch {
    res.statusCode = 403;
    res.end('Forbidden');
    return true;
  }
  try {
    const body = await fs.readFile(target);
    res.statusCode = 200;
    res.setHeader('content-type', contentType(target));
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function hasAuthCredentials(req: http.IncomingMessage, cookieName: string): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return true;
  const cookie = req.headers.cookie;
  if (!cookie) return false;
  return cookie.split(';').some((part) => part.trim().startsWith(`${cookieName}=`));
}

async function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  controlPlaneBaseUrl: string,
  cookieName: string,
): Promise<void> {
  const suffix = pathname.replace(/^\/api/, '') || '/';
  const targetUrl = `${controlPlaneBaseUrl.replace(/\/$/, '')}${suffix}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue;
    if (FORWARDED_HEADERS.has(key.toLowerCase())) {
      headers.set(key, Array.isArray(value) ? value.join(',') : value);
    }
  }

  // Approval header: forward only if the request is authenticated.
  if (hasAuthCredentials(req, cookieName)) {
    const approval = req.headers['x-brownstone-approval'];
    const single = Array.isArray(approval) ? approval[0] : approval;
    if (typeof single === 'string' && single) {
      headers.set('x-brownstone-approval', single);
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : body,
    });

    // SSE streaming pass-through
    const isStreaming = (upstream.headers.get('content-type') || '').includes('text/event-stream');
    if (isStreaming && upstream.body) {
      res.statusCode = upstream.status;
      upstream.headers.forEach((value, key) => {
        if (key === 'transfer-encoding' || key === 'content-encoding') return;
        res.setHeader(key, value);
      });
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) res.write(Buffer.from(value));
        }
        res.end();
      } catch (error) {
        if (!res.writableEnded) res.end();
        console.error('Stream forwarding error:', (error as Error).message);
      }
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      if (key === 'transfer-encoding' || key === 'content-encoding') return;
      res.setHeader(key, value);
    });
    res.end(buffer);
  } catch (error) {
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Control plane unreachable', detail: (error as Error).message }));
  }
}

const config = loadConfig();
assertLocalhostBinding(config.webHost);

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${config.webHost}:${config.webPort}`}`);
      if (url.pathname.startsWith('/api/')) {
        await proxyRequest(req, res, url.pathname + url.search, config.controlPlaneBaseUrl, config.authCookieName);
        return;
      }
      const served = await serveStatic(req, res, url.pathname);
      if (served) return;
      const fallback = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(fallback);
    } catch (error) {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: (error as Error).message }));
      }
    }
  })();
});

installGracefulShutdown(server, {
  timeoutMs: 5000,
  onShutdown: (signal) => console.log(`Web server received ${signal}, draining…`),
});

server.listen(config.webPort, config.webHost, () => {
  console.log(`Brownstone web app running on http://${config.webHost}:${config.webPort}`);
});
