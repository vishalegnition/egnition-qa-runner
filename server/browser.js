import { chromium } from 'playwright-core';

const DEBUG_PORT = process.env.CHROME_DEBUG_PORT || '9222';

function storeHandleFromUrl(storeUrl) {
  const url = storeUrl.replace(/\/$/, '');
  const adminMatch = url.match(/admin\.shopify\.com\/store\/([^/?#]+)/i);
  if (adminMatch) return adminMatch[1];
  const myshopifyMatch = url.match(/https?:\/\/([^.]+)\.myshopify\.com/i);
  return myshopifyMatch?.[1] ?? null;
}

export async function createBrowser() {
  const endpoint = `http://127.0.0.1:${DEBUG_PORT}`;
  try {
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    return { browser, context, page };
  } catch (error) {
    throw new Error(
      'Could not connect to QA Chrome. Make sure the installer script is running and Chrome is open on port ' +
        DEBUG_PORT +
        `. (${error.message})`
    );
  }
}

export async function closePage(page) {
  if (page) {
    await page.close().catch(() => {});
  }
}

/**
 * Verify QA Chrome is logged into the correct dev store before running tests.
 */
export async function validateDevStore(page, appConfig, emit) {
  const storeUrl = appConfig.store_url.replace(/\/$/, '');
  const handle = storeHandleFromUrl(storeUrl);
  const adminUrl = handle
    ? `https://admin.shopify.com/store/${handle}`
    : storeUrl.includes('/admin')
      ? storeUrl
      : `${storeUrl}/admin`;

  emit({ type: 'log', message: `Checking dev store session (${adminUrl})…` });
  await page.goto(adminUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2000);

  const url = page.url();

  if (/\/login|accounts\.shopify\.com\/lookup|no_cookie_session/i.test(url)) {
    const msg =
      `❌ Session expired for ${appConfig.name}.\n` +
      `Please open QA Chrome and log into ${storeUrl} again.\n` +
      `Close and relaunch the installer script after logging in.`;
    emit({ type: 'error', message: msg });
    throw new Error('Dev store session expired');
  }

  const onExpectedStore =
    (handle && /admin\.shopify\.com\/store\/[^/]+/i.test(url) && url.includes(handle)) ||
    url.includes(storeUrl.replace(/^https?:\/\//, '').split('/')[0]);

  if (!onExpectedStore) {
    const msg =
      `⚠️ Wrong store detected. Expected ${storeUrl} but got ${url}.\n` +
      `Please navigate to the correct dev store in QA Chrome and try again.`;
    emit({ type: 'error', message: msg });
    throw new Error('Wrong dev store');
  }

  emit({ type: 'log', message: `✓ Dev store session valid for ${appConfig.name}` });
}
