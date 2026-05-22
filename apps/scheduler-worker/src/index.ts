import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from '@brownstone/config';

/**
 * Dedicated process that fires due scheduled tasks.
 *
 * The original design had the web UI POST /schedules/run-due every 15s. That
 * meant:
 *   - Two open tabs = duplicate runs.
 *   - Schedules don't run when no browser is open.
 *   - The browser became part of the production cron path.
 *
 * Moving this server-side fixes all three. The worker holds a soft "leader"
 * lock via a single advisory file in the data directory so only one scheduler
 * runs even if the operator accidentally starts two.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const { acquireLeaderLock, releaseLeaderLock } = await import('./leader-lock.js');
  const { answerResearchQuestion } = await import('@brownstone/research') as any;
  const { createWebSearchProvider } = await import('@brownstone/web-search') as any;
  const { createModelProvider } = await import('@brownstone/providers-openai') as any;
  const { runDueSchedules } = await import('@brownstone/operations') as any;

  const lock = await acquireLeaderLock(config);
  if (!lock) {
    console.log('Another scheduler instance holds the leader lock. Exiting.');
    return;
  }

  let running = true;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (!running) return;
    running = false;
    console.log(`Scheduler received ${signal}, releasing leader lock…`);
    await releaseLeaderLock(config).catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const provider = createModelProvider(config);
  const searchProvider = createWebSearchProvider(config);

  console.log(`Scheduler tick = ${config.schedulerTickMs}ms`);

  while (running) {
    try {
      const fired = await runDueSchedules(config, async (schedule: any) => {
        const result = await answerResearchQuestion({
          config, provider, searchProvider,
          query: schedule.prompt,
          mode: schedule.thinkingMode,
          fetchPages: true,
        });
        return { summary: result.summary };
      });
      if (Array.isArray(fired) && fired.length) {
        console.log(`Scheduler fired ${fired.length} task(s)`);
      }
    } catch (error) {
      console.error('Scheduler tick failed:', (error as Error).message);
    }
    await sleep(config.schedulerTickMs);
  }
}

main().catch((error) => {
  console.error((error as Error).stack ?? (error as Error).message);
  process.exitCode = 1;
});
