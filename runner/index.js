import { fileURLToPath } from 'url';
import path from 'path';
import { fetchSlackAuthSession } from './fetch-auth-session.js';
import { runCycle } from './run-cycle.js';
import { parseModelResponse } from './vision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export { parseModelResponse };

async function main() {
  const appId = process.env.APP ?? process.argv[2];
  const cycleId = process.env.CYCLE_ID ?? process.argv[3];

  if (!appId || !cycleId) {
    console.error('Usage: APP=<app> CYCLE_ID=<cycle> node runner/index.js');
    console.error('   or: node runner/index.js <app> <cycle-id>');
    process.exit(1);
  }

  const authRunId = process.env.AUTH_RUN_ID;
  if (authRunId && !process.env.SHOPIFY_STORAGE_STATE) {
    const session = await fetchSlackAuthSession(authRunId);
    if (session) {
      process.env.SHOPIFY_STORAGE_STATE = session;
      console.log(`Loaded Shopify session from Slack auth run ${authRunId}`);
    }
  }

  try {
    const results = await runCycle({ appId, cycleId });
    const failed = results.filter((r) => !r.passed).length;
    process.exit(failed > 0 ? 1 : 0);
  } catch {
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
