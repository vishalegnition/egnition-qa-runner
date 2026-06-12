import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchCycleWithTestCases } from './zephyr.js';
import {
  createBrowser,
  closeBrowser,
  openShopifyAdmin,
  assertReadyForTests,
  isSessionExpired,
  isRemoteBrowserSessionError,
  buildBrowserSessionLostMessage,
  updateBrowserStackStatus,
  markBrowserStackSession,
} from './browser.js';
import { runStepLoop } from './actions.js';
import { ensureAppContext } from './navigation.js';
import {
  postResults,
  postError,
  postRunProgress,
  screenshotPath,
  buildProgressFinished,
} from './slack.js';

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

/**
 * Run a Zephyr test cycle via BrowserStack Automate (Playwright CDP).
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
  const { testCases: allTestCases } = await fetchCycleWithTestCases(cycleId);
  const isSmoke = process.env.SMOKE_TEST === 'true';
  const testCases = isSmoke ? allTestCases.slice(0, 1) : allTestCases;

  if (isSmoke) {
    console.log(`SMOKE_TEST=true — running only first case: ${testCases[0]?.key}`);
  }

  let browserHandle;
  const results = [];
  let sessionDead = false;

  try {
    progressTs = await postRunProgress(
      `🏃 *${cycleId}* — starting BrowserStack cloud browser…`,
      channel,
      progressTs
    ).catch(() => progressTs);

    browserHandle = await createBrowser({ cycleId });
    const { page, context } = browserHandle;

    const authMode =
      process.env.SHOPIFY_AUTH_MODE?.trim() ||
      (process.env.BROWSERSTACK_USERNAME?.trim() ? 'login (BrowserStack)' : 'auto');
    progressTs = await postRunProgress(
      `🏃 *${cycleId}* — opening Shopify admin (${authMode})…`,
      channel,
      progressTs
    ).catch(() => progressTs);

    await openShopifyAdmin(context, page, appConfig);

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
          reason: 'Skipped — session lost earlier in this run',
        });
        continue;
      }

      try {
        await assertReadyForTests(page, appConfig);
        await ensureAppContext(page, appConfig);

        console.log(`Running ${tc.key}: ${tc.name}`);
        const result = await runTestCase(page, tc, cycleId, appConfig);
        results.push(result);
        console.log(`  ${result.passed ? 'PASS' : 'FAIL'}: ${result.reason ?? 'ok'}`);

        if (
          !result.passed &&
          (isSessionExpired(page.url()) ||
            /session expired|not on shopify admin|login failed/i.test(result.reason ?? ''))
        ) {
          sessionDead = true;
        }
      } catch (err) {
        if (isRemoteBrowserSessionError(err)) {
          sessionDead = true;
          await postError(
            buildBrowserSessionLostMessage(
              appConfig,
              cycleId,
              results.length,
              allTestCases.length,
              err
            ),
            channel
          );
          results.push({
            key: tc.key,
            name: tc.name,
            passed: false,
            reason: err.message,
          });
          for (let j = i + 1; j < testCases.length; j++) {
            const rest = testCases[j];
            results.push({
              key: rest.key,
              name: rest.name,
              passed: false,
              reason: 'Skipped — BrowserStack session ended',
            });
          }
          break;
        }

        console.error(`Error on ${tc.key}:`, err);
        results.push({
          key: tc.key,
          name: tc.name,
          passed: false,
          reason: err.message,
        });
        if (isRemoteBrowserSessionError(err)) sessionDead = true;
      }

      const passed = results.filter((r) => r.passed).length;
      const failed = results.length - passed;
      const last = results[results.length - 1];
      progressTs = await postRunProgress(
        `🏃 *${cycleId}* — *${tc.key}* ${last?.passed ? '✅' : '❌'} (${n}/${testCases.length}) · ${passed} passed, ${failed} failed`,
        channel,
        progressTs
      );
    }

    const allPassed = results.length > 0 && results.every((r) => r.passed);
    const statusReason = allPassed ? 'All tests passed' : 'One or more tests failed';
    await markBrowserStackSession(browserHandle?.page, allPassed, statusReason);
    await updateBrowserStackStatus(browserHandle?.sessionId, allPassed, statusReason);

    await postRunProgress(buildProgressFinished(cycleId, results), channel, progressTs);
  } catch (err) {
    console.error('Runner error:', err);
    await markBrowserStackSession(browserHandle?.page, false, err.message).catch(() => {});
    await updateBrowserStackStatus(browserHandle?.sessionId, false, err.message).catch(() => {});

    if (isRemoteBrowserSessionError(err)) {
      await postError(
        buildBrowserSessionLostMessage(
          appConfig,
          cycleId,
          results.length,
          allTestCases.length,
          err
        ),
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
    await closeBrowser(browserHandle);
  }

  try {
    await postResults({
      appName: appConfig.name,
      cycleId,
      startedAt,
      durationMs: Date.now() - startedAt.getTime(),
      results,
      slackChannel: channel,
    });
  } catch (postErr) {
    console.error('Failed to post Slack results:', postErr);
    await postError(
      `Run finished but Slack report failed: ${postErr.message}. Check Railway logs.`,
      channel
    );
  }

  return results;
}
