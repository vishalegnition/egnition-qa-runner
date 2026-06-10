import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

/** Env vars the runner child process must receive explicitly. */
const RUNNER_ENV_KEYS = [
  'SHOPIFY_SESSION_COOKIES',
  'CAPSOLVER_API_KEY',
  'CAPSOLVER_PROXY',
  'ZEPHYR_API_TOKEN',
  'OPENROUTER_API_KEY',
  'SLACK_BOT_TOKEN',
  'SLACK_CHANNEL_ID',
];

function buildRunnerEnv({ app, cycleId, slackChannel }) {
  const env = {
    ...process.env,
    APP: app,
    CYCLE_ID: cycleId,
    RUN_ON_RAILWAY: '1',
    DISPLAY: process.env.DISPLAY || ':99',
  };

  for (const key of RUNNER_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (slackChannel) env.SLACK_CHANNEL_ID = slackChannel;

  return env;
}

/**
 * Run the browser test cycle on this Railway instance (headed Chrome via Xvfb).
 */
export function runCycleOnRailway({ app, cycleId, slackChannel }) {
  const runnerPath = path.join(repoRoot, 'runner', 'index.js');
  const env = buildRunnerEnv({ app, cycleId, slackChannel });

  console.log(`Starting Railway browser test run: ${app} / ${cycleId}`);
  console.log(
    `Runner env: cookies=${Boolean(env.SHOPIFY_SESSION_COOKIES?.trim())} ` +
      `capsolver=${Boolean(env.CAPSOLVER_API_KEY?.trim())} ` +
      `proxy=${Boolean(env.CAPSOLVER_PROXY?.trim())}`
  );

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
