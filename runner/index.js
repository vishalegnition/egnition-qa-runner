import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchCycleWithTestCases } from './zephyr.js';
import { launchBrowser, loginToShopify, closeBrowser } from './browser.js';
import { runStepLoop } from './actions.js';
import { postResults, postError, screenshotPath } from './slack.js';
import { parseModelResponse } from './vision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAppConfig(appId) {
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

  const getScreenshot = async () => {
    return page.screenshot({ fullPage: true, type: 'png' });
  };

  for (const step of testCase.steps) {
    const stepText = [step.step, step.testData].filter(Boolean).join('\n');
    const result = await runStepLoop(
      page,
      getScreenshot,
      { step: stepText },
      step.expectedResult
    );

    stepResults.push(result);
    if (result.screenshot) {
      finalScreenshot = result.screenshot;
    }

    if (!result.passed) {
      failedReason = result.reason;
      break;
    }
  }

  const passed = stepResults.length > 0 && stepResults.every((s) => s.passed);
  const status = passed ? 'pass' : 'fail';
  const outPath = screenshotPath(cycleId, testCase.key, status);

  if (finalScreenshot) {
    fs.writeFileSync(outPath, finalScreenshot);
  }

  return {
    key: testCase.key,
    name: testCase.name,
    passed,
    reason: failedReason ?? (passed ? undefined : 'No steps executed'),
    screenshotPath: finalScreenshot ? outPath : undefined,
  };
}

export async function main() {
  const appId = process.env.APP ?? process.argv[2];
  const cycleId = process.env.CYCLE_ID ?? process.argv[3];

  if (!appId || !cycleId) {
    console.error('Usage: APP=<app> CYCLE_ID=<cycle> node runner/index.js');
    console.error('   or: node runner/index.js <app> <cycle-id>');
    process.exit(1);
  }

  const startedAt = new Date();
  let appConfig;

  try {
    appConfig = loadAppConfig(appId);
  } catch (err) {
    await postError(err.message);
    process.exit(1);
  }

  const storeUrl = appConfig.store_url;
  if (!storeUrl || storeUrl.includes('your-') || storeUrl.includes('-dev.myshopify.com')) {
    // Allow placeholder URLs but warn — real URLs should be in apps.json
  }

  let testCases;
  try {
    env('ZEPHYR_API_TOKEN');
    const data = await fetchCycleWithTestCases(cycleId);
    testCases = data.testCases;
  } catch (err) {
    if (err.status === 404 || err.message?.includes('404')) {
      await postError(
        `Could not find Zephyr cycle "${cycleId}". In Zephyr Scale, open the cycle and copy its key from the URL or header (e.g. BR-R104). Then run: /run-tests br ${cycleId}`
      );
    } else {
      await postError(`Zephyr error: ${err.message}`);
    }
    process.exit(1);
  }

  let browser;
  let page;
  const results = [];

  try {
    ({ browser, page } = await launchBrowser());

    try {
      await loginToShopify(page, storeUrl);
    } catch (err) {
      await postError(
        `Shopify login failed: ${err.message}. Check SHOPIFY_ADMIN_EMAIL, SHOPIFY_ADMIN_PASSWORD, and SHOPIFY_2FA_SECRET.`
      );
      process.exit(1);
    }

    for (const tc of testCases) {
      console.log(`Running ${tc.key}: ${tc.name}`);
      const result = await runTestCase(page, tc, cycleId);
      results.push(result);
      console.log(`  ${result.passed ? 'PASS' : 'FAIL'}: ${result.reason ?? 'ok'}`);
    }
  } catch (err) {
    console.error('Runner error:', err);
    await postError(`Runner crashed: ${err.message}`);
    if (results.length > 0) {
      await postResults({
        appName: appConfig.name,
        cycleId,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        results,
      });
    }
    process.exit(1);
  } finally {
    await closeBrowser(browser);
  }

  const durationMs = Date.now() - startedAt.getTime();

  try {
    env('SLACK_BOT_TOKEN');
    env('SLACK_CHANNEL_ID');
    await postResults({
      appName: appConfig.name,
      cycleId,
      startedAt,
      durationMs,
      results,
    });
  } catch (err) {
    console.error('Failed to post Slack report:', err.message);
    process.exit(1);
  }

  const failed = results.filter((r) => !r.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}

// Re-export parseModelResponse for tests
export { parseModelResponse };

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
