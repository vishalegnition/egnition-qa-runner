import { runCycle } from '../runner/run-cycle.js';
import { exportAuthStorageState, getAuthSession, stopAuthBrowser } from './auth-browser.js';
import { savePersistedSession } from '../session/persistent-session.js';
import { storeSession } from './pending-runs.js';
import { postError, postRunProgress } from '../runner/slack.js';

/**
 * Run tests in the same browser the user just logged into — avoids Cloudflare re-challenge.
 */
export async function runCycleOnAuthBrowser({ runId, app, cycleId, slackChannel }) {
  const session = getAuthSession(runId);
  if (!session) {
    throw new Error('Auth browser session not found');
  }

  try {
    console.log(`Auth handoff: starting ${app} / ${cycleId}`);
    await postRunProgress(`🏃 *${cycleId}* — loading test cases from Zephyr…`, slackChannel);

    const storageStateBase64 = await exportAuthStorageState(runId);
    storeSession(runId, storageStateBase64);
    savePersistedSession(storageStateBase64);

    await runCycle({
      appId: app,
      cycleId,
      page: session.page,
      browser: session.browser,
      slackChannel,
      skipLogin: true,
    });
  } catch (err) {
    console.error('runCycleOnAuthBrowser error:', err);
    await postError(`Test run failed: ${err.message}`, slackChannel);
    throw err;
  } finally {
    await stopAuthBrowser(runId);
  }
}
