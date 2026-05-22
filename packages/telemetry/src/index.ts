import path from 'node:path';
import type { AgentConfig, TelemetryEvent } from '@brownstone/contracts';
import { appendJsonl, readJsonlTail } from '@brownstone/storage';

/**
 * Telemetry log: append-only JSONL at {dataDir}/telemetry/events.jsonl.
 * Cheap to write, cheap to tail. No retention policy here — operators can
 * `logrotate` the file or truncate it manually. The reader skips malformed
 * lines so a partial write at the tail won't poison reads.
 */

function telemetryPath(config: AgentConfig): string {
  return path.join(config.dataDir, 'telemetry', 'events.jsonl');
}

export async function writeEvent(config: AgentConfig, event: TelemetryEvent): Promise<void> {
  await appendJsonl(telemetryPath(config), event);
}

export async function tailEvents(config: AgentConfig, n: number): Promise<TelemetryEvent[]> {
  return readJsonlTail<TelemetryEvent>(telemetryPath(config), n);
}
