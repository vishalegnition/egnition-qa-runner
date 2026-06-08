/**
 * Execute vision model actions via Playwright.
 */

import { getSessionBlockReason } from './browser.js';

const MAX_ITERATIONS = 10;

function locatorForTarget(page, target) {
  const t = String(target).trim();
  return page
    .getByRole('button', { name: new RegExp(t, 'i') })
    .or(page.getByRole('link', { name: new RegExp(t, 'i') }))
    .or(page.getByRole('textbox', { name: new RegExp(t, 'i') }))
    .or(page.getByLabel(new RegExp(t, 'i')))
    .or(page.getByText(new RegExp(t, 'i')))
    .or(page.getByPlaceholder(new RegExp(t, 'i')))
    .or(page.locator(`[aria-label*="${t.replace(/"/g, '\\"')}"]`))
    .first();
}

export async function executeAction(page, actionObj) {
  const { action } = actionObj;

  switch (action) {
    case 'click': {
      const loc = locatorForTarget(page, actionObj.target);
      await loc.click({ timeout: 15000 });
      break;
    }
    case 'fill': {
      const loc = locatorForTarget(page, actionObj.target);
      await loc.clear();
      await loc.fill(actionObj.value ?? '');
      break;
    }
    case 'navigate':
      await page.goto(actionObj.url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
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
export async function runStepLoop(page, getScreenshot, step, expectedResult) {
  const { getNextAction } = await import('./vision.js');

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let screenshot;
    try {
      const block = await getSessionBlockReason(page);
      if (block) {
        screenshot = await getScreenshot().catch(() => null);
        return { passed: false, reason: block, screenshot };
      }

      screenshot = await getScreenshot();
      const actionObj = await getNextAction(screenshot, step.step, expectedResult);

      if (actionObj.action === 'assert') {
        return {
          passed: actionObj.result === 'PASS',
          reason: actionObj.reason ?? '',
          screenshot,
        };
      }

      await executeAction(page, actionObj);
      await page.waitForTimeout(500);
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
