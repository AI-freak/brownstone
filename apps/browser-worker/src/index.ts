import { loadConfig } from '@brownstone/config';
import { startBrowserWorkerServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  // The real browser driver lives in @brownstone/browser-automation. Import
  // late to keep startup tolerant of optional headless-browser dependencies.
  const { createBrowserDriver } = await import('@brownstone/browser-automation') as any;
  const driver = createBrowserDriver();
  const started = await startBrowserWorkerServer({ config, driver });
  console.log(`Brownstone browser worker listening on ${started.baseUrl}`);
}

main().catch((error) => {
  console.error((error as Error).stack ?? (error as Error).message);
  process.exitCode = 1;
});
