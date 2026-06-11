/**
 * Execute vision model actions via Playwright.
 */

import { getSessionBlockReason } from './browser.js';
import { findClickable, findFillable, ensureAppContext, isInAppContext } from './navigation.js';

const MAX_ITERATIONS = 10;
const ACTION_TIMEOUT = 25000;

export async function executeAction(page, actionObj, appConfig) {
  const { action } = actionObj;

  switch (action) {
    case 'click': {
      if (
        appConfig &&
        !isInAppContext(page, appConfig) &&
        /bestsellers?|resort|stockiq|commetiq|order limits|multi-?store/i.test(
          String(actionObj.target ?? '')
        )
      ) {
        await ensureAppContext(page, appConfig).catch((err) => {
          console.warn(`ensureAppContext before click: ${err.message}`);
        });
      }
      const loc = await findClickable(page, actionObj.target, appConfig);
      if (!loc) {
        throw new Error(`Element not found: ${actionObj.target}`);
      }
      await loc.click({ timeout: ACTION_TIMEOUT });
      break;
    }
    case 'fill': {
      const loc = await findFillable(page, actionObj.target, appConfig);
      if (!loc) {
        throw new Error(`Field not found: ${actionObj.target}`);
      }
      await loc.clear();
      await loc.fill(actionObj.value ?? '', { timeout: ACTION_TIMEOUT });
      break;
    }
    case 'navigate':
      await page.goto(actionObj.url, {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
      });
      await page.waitForTimeout(1500);
      break;
    case 'scroll':
      if (actionObj.direction === 'up') {
        await page.evaluate(() => window.scrollBy(0, -500));
      } else {
        await page.evaluate(() => window.scrollBy(0, 500));
      }
      break;
    case 'wait':
      await page.waitForTimeout((actionObj.seconds ?? 2) * 1000);
      break;
    case 'assert':
      return {
        done: true,
        passed: actionObj.result === 'PASS',
        reason: actionObj.reason ?? '',
      };
    default:
      throw new Error(`Unknown action: ${action}`);
  }

  return { done: false };
}

/**
 * Run vision loop for a single Zephyr step (max 10 iterations).
 */
export async function runStepLoop(page, getScreenshot, step, expectedResult, appConfig) {
  const { getNextAction } = await import('./vision.js');

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let screenshot;
    try {
      const block = appConfig ? await getSessionBlockReason(page, appConfig) : null;
      if (block) {
        screenshot = await getScreenshot().catch(() => null);
        return { passed: false, reason: block, screenshot };
      }

      screenshot = await getScreenshot();
      const actionObj = await getNextAction(
        screenshot,
        step.step,
        expectedResult,
        appConfig
      );

      if (actionObj.action === 'assert') {
        return {
          passed: actionObj.result === 'PASS',
          reason: actionObj.reason ?? '',
          screenshot,
        };
      }

      await executeAction(page, actionObj, appConfig);
      await page.waitForTimeout(800);
    } catch (err) {
      if (err.message?.includes('AI service unavailable')) {
        return {
          passed: false,
          reason: 'AI service unavailable',
          screenshot: screenshot ?? (await getScreenshot().catch(() => null)),
        };
      }
      if (err.message?.includes('invalid model response') || err instanceof SyntaxError) {
        console.error('Invalid model response:', err.message);
        return {
          passed: false,
          reason: 'invalid model response',
          screenshot: screenshot ?? (await getScreenshot().catch(() => null)),
        };
      }
      return {
        passed: false,
        reason: err.message ?? String(err),
        screenshot: screenshot ?? (await getScreenshot().catch(() => null)),
      };
    }
  }

  const screenshot = await getScreenshot().catch(() => null);
  return {
    passed: false,
    reason: 'max iterations exceeded',
    screenshot,
  };
}
