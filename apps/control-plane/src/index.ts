import { loadConfig } from '@brownstone/config';
import { startControlPlaneServer } from './server.js';
import { buildCapabilities } from './capabilities-default.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const capabilities = await buildCapabilities(config);
  const started = await startControlPlaneServer({ config, capabilities });
  console.log(`Brownstone control plane listening on ${started.baseUrl}`);
  console.log(`  permission mode:     ${config.permissionMode}`);
  console.log(`  provider:            ${config.providerMode}`);
  console.log(`  approval required:   ${config.requireApprovalForWrites}`);
  console.log(`  registration open:   ${config.allowRegistration}`);
}

main().catch((error) => {
  console.error((error as Error).stack ?? (error as Error).message);
  process.exitCode = 1;
});
