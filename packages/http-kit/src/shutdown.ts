import type http from 'node:http';

export interface GracefulShutdownOptions {
  /** How long to wait for in-flight requests before forcing close. */
  timeoutMs?: number;
  /** Optional callback for logging shutdown progress. */
  onShutdown?: (signal: NodeJS.Signals | 'manual') => void;
  /** Additional async resources to drain before fully exiting. */
  drain?: () => Promise<void>;
  /**
   * Whether to register SIGINT/SIGTERM handlers. Defaults to true.
   * Set false in tests where multiple servers boot in one process.
   */
  installSignalHandlers?: boolean;
}

/**
 * Wire SIGINT/SIGTERM to graceful shutdown:
 *   1. Stop accepting new connections (server.close()).
 *   2. Allow in-flight requests up to `timeoutMs` to complete.
 *   3. After timeout, destroy keep-alive sockets and exit.
 *
 * Returns a `shutdown` function callable from tests.
 */
export function installGracefulShutdown(server: http.Server, options: GracefulShutdownOptions = {}): {
  shutdown: (signal?: NodeJS.Signals | 'manual') => Promise<void>;
} {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const sockets = new Set<import('node:net').Socket>();

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  let shuttingDown = false;

  async function shutdown(signal: NodeJS.Signals | 'manual' = 'manual'): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    options.onShutdown?.(signal);

    const closing = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

    // After timeout, destroy idle sockets so server.close can resolve.
    const timer = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, timeoutMs);
    timer.unref();

    try {
      await closing;
    } finally {
      clearTimeout(timer);
    }

    if (options.drain) {
      try { await options.drain(); } catch { /* logged by caller */ }
    }
  }

  const onSignal = (signal: NodeJS.Signals) => {
    shutdown(signal).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };

  // Only install once per process — multiple servers in the same process
  // (e.g. integration tests) would otherwise pile up listeners.
  if (options.installSignalHandlers !== false) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  return { shutdown };
}
