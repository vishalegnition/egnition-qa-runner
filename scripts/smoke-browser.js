/**
 * Launch Chromium and open a page (no Shopify login).
 */
import { launchBrowser, closeBrowser } from '../runner/browser.js';

process.env.PLAYWRIGHT_HEADLESS = 'true';

const { browser, page } = await launchBrowser();
try {
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const title = await page.title();
  console.log(`Browser smoke OK — title: "${title}"`);
} finally {
  await closeBrowser(browser);
}
