import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchConfig, applyConfig } from './config.js';
import { createBrowser, closePage, validateDevStore } from './browser.js';
import { saveRun } from './history.js';
import { fetchCycleWithTestCases } from '../runner/zephyr.js';
import { runStepLoop } from '../runner/actions.js';
import { ensureAppContext } from '../runner/navigation.js';
import { postResults, summarizeResults, screenshotPath } from '../runner/slack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadAppConfig(appId) {
  const configPath = path.join(__dirname, '..', 'config', 'apps.json');
  const apps = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const app = apps[appId?.toLowerCase()];
  if (!app) {
    throw new Error(`Unknown app "${appId}". Valid: ${Object.keys(apps).join(', ')}`);
  }
  return app;
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
 * Run a full Zephyr cycle locally via QA Chrome + SSE logging.
 */
export async function runLocalCycle({ appId, cycleId, runId, emit }) {
  const startedAt = new Date();
  let page;

  try {
    emit({ type: 'log', message: 'Fetching config from Railway…' });
    const remoteConfig = await fetchConfig();
    applyConfig(remoteConfig);

    const appConfig = loadAppConfig(appId);

    emit({ type: 'log', message: `Fetching test cases from Zephyr (${cycleId})…` });
    const { testCases } = await fetchCycleWithTestCases(cycleId);
    emit({ type: 'log', message: `Found ${testCases.length} test cases` });

    emit({ type: 'log', message: 'Connecting to QA Chrome…' });
    ({ page } = await createBrowser());

    await validateDevStore(page, appConfig, emit);

    emit({ type: 'log', message: `Opening ${appConfig.name} app…` });
    await ensureAppContext(page, appConfig);

    const results = [];

    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i];
      emit({ type: 'log', message: `Running ${tc.key}: ${tc.name} (${i + 1}/${testCases.length})…` });

      try {
        await ensureAppContext(page, appConfig);
        const result = await runTestCase(page, tc, cycleId, appConfig);
        results.push(result);

        if (result.passed) {
          emit({ type: 'log', message: `✅ ${tc.key}: PASSED` });
        } else {
          emit({
            type: 'log',
            message: `❌ ${tc.key}: FAILED — ${result.reason ?? 'unknown'}`,
          });
        }
      } catch (err) {
        results.push({
          key: tc.key,
          name: tc.name,
          passed: false,
          reason: err.message,
        });
        emit({ type: 'log', message: `❌ ${tc.key}: FAILED — ${err.message}` });
      }
    }

    const { passed, failed, total, rate } = summarizeResults(results);
    const durationMs = Date.now() - startedAt.getTime();

    emit({ type: 'log', message: 'Posting Slack report…' });
    await postResults({
      appName: appConfig.name,
      cycleId,
      startedAt,
      durationMs,
      results,
    });
    emit({ type: 'log', message: 'Slack report posted ✓' });

    saveRun({
      id: runId,
      app: appConfig.name,
      cycleId,
      date: startedAt.toISOString(),
      total,
      passed,
      failed,
      passRate: `${rate}%`,
    });

    emit({
      type: 'complete',
      summary: { total, passed, failed, passRate: `${rate}%` },
    });
  } catch (err) {
    emit({ type: 'error', message: err.message });
    throw err;
  } finally {
    await closePage(page);
  }
}
