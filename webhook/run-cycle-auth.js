import { runCycle } from '../runner/run-cycle.js';
import { exportAuthStorageState, getAuthSession, stopAuthBrowser } from './auth-browser.js';
import { savePersistedSession } from '../session/persistent-session.js';
import { postError } from '../runner/slack.js';

/**
 * Run tests in the same browser the user just logged into — avoids Cloudflare re-challenge.
 */
export async function runCycleOnAuthBrowser({ runId, app, cycleId, slackChannel }) {
  const session = getAuthSession(runId);
  if (!session) {
    throw new Error('Auth browser session not found');
  }

  try {
    const storageStateBase64 = await exportAuthStorageState(runId);
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
    if (!/session expired/i.test(err?.message ?? '')) {
      await postError(`Test run failed: ${err.message}`, slackChannel);
    }
    throw err;
  } finally {
    await stopAuthBrowser(runId);
  }
}
