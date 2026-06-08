import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchCycleWithTestCases } from './zephyr.js';
import { launchBrowser, loginToShopify, closeBrowser } from './browser.js';
import { runStepLoop } from './actions.js';
import { postResults, postError, screenshotPath } from './slack.js';
import { clearPersistedSession } from '../session/persistent-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadAppConfig(appId) {
  const configPath = path.join(__dirname, '..', 'config', 'apps.json');
  const apps = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const app = apps[appId?.toLowerCase()];
  if (!app) {
    const valid = Object.keys(apps).join(', ');
    throw new Error(`Unknown app "${appId}". Valid apps: ${valid}`);
  }
  return app;
}

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

async function runTestCase(page, testCase, cycleId) {
  const stepResults = [];
  let finalScreenshot = null;
  let failedReason = null;

  const getScreenshot = async () => page.screenshot({ fullPage: true, type: 'png' });

  for (const step of testCase.steps) {
    const stepText = [step.step, step.testData].filter(Boolean).join('\n');
    const result = await runStepLoop(page, getScreenshot, { step: stepText }, step.expectedResult);

    stepResults.push(result);
    if (result.screenshot) finalScreenshot = result.screenshot;

    if (!result.passed) {
      failedReason = result.reason;
      break;
    }
  }

  const passed = stepResults.length > 0 && stepResults.every((s) => s.passed);
  const status = passed ? 'pass' : 'fail';
  const outPath = screenshotPath(cycleId, testCase.key, status);

  if (finalScreenshot) fs.writeFileSync(outPath, finalScreenshot);

  return {
    key: testCase.key,
    name: testCase.name,
    passed,
    reason: failedReason ?? (passed ? undefined : 'No steps executed'),
    screenshotPath: finalScreenshot ? outPath : undefined,
  };
}

function isLoginError(err) {
  const msg = err?.message ?? '';
  return /cloudflare|shopify login|session|log in|unauthorized|expired/i.test(msg);
}

/**
 * Run a Zephyr cycle. Pass an existing authenticated `page` to skip login (Slack auth handoff).
 */
export async function runCycle({
  appId,
  cycleId,
  page: existingPage,
  browser: existingBrowser,
  slackChannel,
  skipLogin = false,
}) {
  const startedAt = new Date();
  const appConfig = loadAppConfig(appId);
  const channel = slackChannel || process.env.SLACK_CHANNEL_ID;

  env('ZEPHYR_API_TOKEN');
  const { testCases } = await fetchCycleWithTestCases(cycleId);

  let browser = existingBrowser;
  let page = existingPage;
  let ownsBrowser = false;
  const results = [];

  try {
    if (!page) {
      ownsBrowser = true;
      const launched = await launchBrowser();
      browser = launched.browser;
      page = launched.page;
      await loginToShopify(page, appConfig.store_url, {
        hasStorageState: launched.hasStorageState,
      });
    } else if (!skipLogin) {
      await loginToShopify(page, appConfig.store_url, { hasStorageState: true });
    }

    for (const tc of testCases) {
      console.log(`Running ${tc.key}: ${tc.name}`);
      const result = await runTestCase(page, tc, cycleId);
      results.push(result);
      console.log(`  ${result.passed ? 'PASS' : 'FAIL'}: ${result.reason ?? 'ok'}`);
    }
  } catch (err) {
    console.error('Runner error:', err);
    if (isLoginError(err)) {
      clearPersistedSession();
      await postError(
        `${err.message}\n\n_Shopify session expired. Run \`/run-tests ${appId} ${cycleId}\` again — you'll get a login link in this channel._`,
        channel
      );
    } else {
      await postError(`Runner crashed: ${err.message}`, channel);
    }
    if (results.length > 0) {
      await postResults({
        appName: appConfig.name,
        cycleId,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        results,
        slackChannel: channel,
      });
    }
    throw err;
  } finally {
    if (ownsBrowser) await closeBrowser(browser);
  }

  env('SLACK_BOT_TOKEN');
  await postResults({
    appName: appConfig.name,
    cycleId,
    startedAt,
    durationMs: Date.now() - startedAt.getTime(),
    results,
    slackChannel: channel,
  });

  return results;
}
