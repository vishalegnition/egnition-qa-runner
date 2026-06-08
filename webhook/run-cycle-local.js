import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

/**
 * Run tests on Railway using a saved session (subsequent /run-tests without re-login).
 */
export function runCycleLocally({ app, cycleId, storageStateBase64, slackChannel }) {
  const runnerPath = path.join(repoRoot, 'runner', 'index.js');
  const env = {
    ...process.env,
    APP: app,
    CYCLE_ID: cycleId,
    SHOPIFY_STORAGE_STATE: storageStateBase64,
    RAILWAY_LOCAL_SESSION: '1',
  };
  if (slackChannel) env.SLACK_CHANNEL_ID = slackChannel;

  console.log(`Starting test run with saved session: ${app} / ${cycleId}`);

  const child = spawn(process.execPath, [runnerPath], {
    env,
    cwd: repoRoot,
    detached: true,
    stdio: 'inherit',
  });

  child.unref();
  child.on('error', (err) => console.error('Local runner failed to start:', err));

  return child.pid;
}
