import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchCycleWithTestCases } from './zephyr.js';
import {
  launchBrowser,
  openShopifyAdminWithCookies,
  closeBrowser,
  assertReadyForTests,
  buildSessionExpiredMessage,
  isSessionExpired,
} from './browser.js';
import { runStepLoop } from './actions.js';
import { ensureAppContext } from './navigation.js';
import { postResults, postError, postRunProgress, screenshotPath } from './slack.js';

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

async function runTestCase(page, testCase, cycleId, appConfig) {
  const stepResults = [];
  let finalScreenshot = null;
  let failedReason = null;

  const getScreenshot = async () => page.screenshot({ fullPage: true, type: 'png' });

  for (const step of testCase.steps) {
    const stepText = [step.step, step.testData].filter(Boolean).join('\n');
    const result = await runStepLoop(
      page,
      getScreenshot,
      { step: stepText },
      step.expectedResult,
      appConfig
    );

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

function isSessionError(msg = '') {
  return /session expired|cloudflare|cookie|SHOPIFY_SESSION_COOKIES|verify you are human/i.test(
    msg
  );
}

/**
 * Run a Zephyr test cycle with cookie-injected Shopify session.
 */
export async function runCycle({ appId, cycleId, slackChannel }) {
  const startedAt = new Date();
  const appConfig = loadAppConfig(appId);
  const channel = slackChannel || process.env.SLACK_CHANNEL_ID;

  env('SLACK_BOT_TOKEN');
  let progressTs = await postRunProgress(
    `🏃 *${cycleId}* — fetching test cases from Zephyr…`,
    channel
  ).catch(() => null);

  env('ZEPHYR_API_TOKEN');
  const { testCases } = await fetchCycleWithTestCases(cycleId);

  let browser;
  let context;
  let page;
  const results = [];

  try {
    ({ browser, context, page } = await launchBrowser());

    progressTs = await postRunProgress(
      `🏃 *${cycleId}* — opening Shopify admin with session cookies…`,
      channel,
      progressTs
    ).catch(() => progressTs);

    await openShopifyAdminWithCookies(context, page, appConfig);

    progressTs = await postRunProgress(
      `🏃 *${cycleId}* — opening *${appConfig.name}* app…`,
      channel,
      progressTs
    ).catch(() => progressTs);

    await ensureAppContext(page, appConfig);

    progressTs = await postRunProgress(
      `🏃 *${cycleId}* — loaded ${testCases.length} test cases, starting…`,
      channel,
      progressTs
    ).catch(() => progressTs);

    let sessionDead = false;

    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i];
      const n = i + 1;

      progressTs = await postRunProgress(
        `🏃 *${cycleId}* — running *${tc.key}*: ${tc.name} (${n}/${testCases.length})`,
        channel,
        progressTs
      );

      if (sessionDead) {
        results.push({
          key: tc.key,
          name: tc.name,
          passed: false,
          reason: 'Skipped — Shopify session expired earlier in this run',
        });
        continue;
      }

      try {
        await assertReadyForTests(page, appConfig);
      } catch (err) {
        sessionDead = true;
        await postError(err.message, channel);
        results.push({
          key: tc.key,
          name: tc.name,
          passed: false,
          reason: err.message,
        });
        continue;
      }

      console.log(`Running ${tc.key}: ${tc.name}`);
      try {
        await ensureAppContext(page, appConfig);
      } catch (navErr) {
        console.warn(`App navigation warning: ${navErr.message}`);
      }
      const result = await runTestCase(page, tc, cycleId, appConfig);
      results.push(result);
      console.log(`  ${result.passed ? 'PASS' : 'FAIL'}: ${result.reason ?? 'ok'}`);

      if (
        !result.passed &&
        (isSessionExpired(page.url()) ||
          /cloudflare|verify you are human|session expired|not on shopify admin/i.test(
            result.reason ?? ''
          ))
      ) {
        sessionDead = true;
        if (/cloudflare|verify you are human/i.test(result.reason ?? '')) {
          const { buildCloudflareBlockedMessage } = await import('./browser.js');
          await postError(buildCloudflareBlockedMessage(), channel);
        }
      }

      const passed = results.filter((r) => r.passed).length;
      const failed = results.length - passed;
      progressTs = await postRunProgress(
        `🏃 *${cycleId}* — *${tc.key}* ${result.passed ? '✅' : '❌'} (${n}/${testCases.length}) · ${passed} passed, ${failed} failed`,
        channel,
        progressTs
      );
    }

    await postRunProgress(`✅ *${cycleId}* finished — posting full results…`, channel, progressTs);
  } catch (err) {
    console.error('Runner error:', err);
    if (isSessionError(err.message)) {
      await postError(err.message, channel);
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
    await closeBrowser(browser);
  }

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
