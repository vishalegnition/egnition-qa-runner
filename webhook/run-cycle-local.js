import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

/**
 * Run the browser test cycle on this Railway instance (headed Chrome via Xvfb).
 */
export function runCycleOnRailway({ app, cycleId, slackChannel }) {
  const runnerPath = path.join(repoRoot, 'runner', 'index.js');
  const env = {
    ...process.env,
    APP: app,
    CYCLE_ID: cycleId,
    RUN_ON_RAILWAY: '1',
    DISPLAY: process.env.DISPLAY || ':99',
  };
  if (slackChannel) env.SLACK_CHANNEL_ID = slackChannel;

  console.log(`Starting Railway browser test run: ${app} / ${cycleId}`);

  const child = spawn(process.execPath, [runnerPath], {
    env,
    cwd: repoRoot,
    detached: true,
    stdio: 'inherit',
  });

  child.unref();
  child.on('error', (err) => console.error('Railway runner failed to start:', err));

  return child.pid;
}
