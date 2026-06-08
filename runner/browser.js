import { chromium } from 'patchright';

const HEADLESS = process.env.PLAYWRIGHT_HEADLESS === 'true';

function storeHandleFromUrl(storeUrl) {
  const url = storeUrl.replace(/\/$/, '');
  const adminMatch = url.match(/admin\.shopify\.com\/store\/([^/?#]+)/i);
  if (adminMatch) return adminMatch[1];
  const myshopifyMatch = url.match(/https?:\/\/([^.]+)\.myshopify\.com/i);
  if (myshopifyMatch) return myshopifyMatch[1];
  return null;
}

export function storeAdminUrl(storeUrl) {
  const handle = storeHandleFromUrl(storeUrl);
  if (handle) return `https://admin.shopify.com/store/${handle}`;
  const base = storeUrl.replace(/\/$/, '');
  return base.includes('/admin') ? base : `${base}/admin`;
}

/** Load Cookie-Editor JSON from the env var named in apps.json `cookie_secret_name`. */
export function loadSessionCookies(cookieSecretName) {
  if (!cookieSecretName) {
    throw new Error('App config missing cookie_secret_name in config/apps.json');
  }

  const raw = process.env[cookieSecretName];
  if (!raw?.trim()) {
    throw new Error(
      `Missing GitHub secret ${cookieSecretName}. Export cookies from the dev store admin via Cookie-Editor.`
    );
  }

  try {
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) {
      throw new Error('Cookie JSON must be a non-empty array');
    }
    return cookies;
  } catch (err) {
    if (err.message?.includes('Cookie JSON')) throw err;
    throw new Error(
      `Invalid JSON in ${cookieSecretName}. Export cookies via Cookie-Editor → Export as JSON.`
    );
  }
}

export function isSessionExpired(url) {
  return /\/login|\/account\/login|accounts\.shopify\.com|no_cookie_session/i.test(url);
}

export function buildSessionExpiredMessage(appConfig) {
  const secret = appConfig.cookie_secret_name ?? 'SHOPIFY_SESSION_COOKIES_*';
  const store = appConfig.store_url?.replace(/\/$/, '') ?? '[store]';
  return (
    `Session expired for ${appConfig.name} dev store.\n` +
    `Please refresh the cookies in GitHub Actions secrets.\n` +
    `Secret name: ${secret}\n` +
    `Steps: Log in to ${store}/admin with "Remember me" checked → export cookies via Cookie-Editor → paste into the secret.`
  );
}

function emailInput(page) {
  return page
    .locator('input[type="email"]')
    .or(page.getByLabel(/email/i))
    .or(page.locator('input[name="account[email]"]'));
}

async function isAdminReady(page) {
  const url = page.url();
  if (!/admin\.shopify\.com\/store\//i.test(url) && !/\.myshopify\.com\/admin/i.test(url)) {
    return false;
  }
  return !(await emailInput(page).first().isVisible().catch(() => false));
}

export async function launchBrowser() {
  const browser = await chromium.launch({
    headless: HEADLESS,
    channel: 'chrome',
    args: HEADLESS ? [] : ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * Inject session cookies and open Shopify admin. Throws if session expired.
 */
export async function openShopifyAdminWithCookies(context, page, appConfig) {
  const cookies = loadSessionCookies(appConfig.cookie_secret_name);
  await context.addCookies(cookies);

  const target = storeAdminUrl(appConfig.store_url);
  console.log(`Navigating to ${target} with injected session cookies`);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });

  await page.waitForTimeout(2000);
  const url = page.url();

  if (isSessionExpired(url) || !(await isAdminReady(page))) {
    throw new Error(buildSessionExpiredMessage(appConfig));
  }

  console.log('Shopify admin session valid');
}

export async function closeBrowser(browser) {
  if (browser) {
    await browser.close().catch(() => {});
  }
}

/** Human-readable reason if the page is not ready for test steps. */
export async function getSessionBlockReason(page, appConfig) {
  const url = page.url();
  if (isSessionExpired(url)) {
    return buildSessionExpiredMessage(appConfig);
  }
  if (!(await isAdminReady(page))) {
    return `Not on Shopify admin (${url}). ${buildSessionExpiredMessage(appConfig)}`;
  }
  return null;
}

export async function assertReadyForTests(page, appConfig) {
  const reason = await getSessionBlockReason(page, appConfig);
  if (reason) throw new Error(reason);
}
