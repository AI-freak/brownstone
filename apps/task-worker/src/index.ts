import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from '@brownstone/config';

/**
 * Long-running worker process that pops tasks from the global queue.
 *
 * Shutdown behavior:
 *   - SIGTERM/SIGINT sets a flag; the current task is allowed to finish.
 *   - The poll loop then exits cleanly with code 0.
 *   - If the in-flight task itself takes too long, the process supervisor
 *     (systemd / docker) will SIGKILL after its own grace period; we don't
 *     attempt to interrupt the user's task mid-step.
 *
 * Original had a bare `while(true)` with no shutdown handling — point #14.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const { processNextTask } = await import('@brownstone/task-executor') as any;

  let running = true;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (!running) return;
    console.log(`Task worker received ${signal}, finishing in-flight work…`);
    running = false;
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  console.log('Brownstone task worker running');

  while (running) {
    try {
      const task = await processNextTask(config);
      if (!task) {
        await sleep(config.taskPollMs);
        continue;
      }
      console.log(`Processed task ${task.id} (${task.kind}) → ${task.status}`);
    } catch (error) {
      console.error('Task processing error:', (error as Error).message);
      // Brief back-off so a persistent failure doesn't peg the CPU.
      await sleep(Math.min(config.taskPollMs * 2, 5000));
    }
  }

  console.log('Task worker shut down cleanly');
}

main().catch((error) => {
  console.error((error as Error).stack ?? (error as Error).message);
  process.exitCode = 1;
});
