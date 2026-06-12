import https from 'node:https';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { generate as generateTotp } from 'otplib';
import { bypassCloudflareOnPage } from './capsolver.js';
import { getProxyConfig } from './proxy.js';

const require = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION = require('playwright-core/package.json').version;

function browserStackCredentials() {
  const username = process.env.BROWSERSTACK_USERNAME?.trim();
  const accessKey = process.env.BROWSERSTACK_ACCESS_KEY?.trim();
  if (!username || !accessKey) {
    throw new Error(
      'BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY are required — get them from browserstack.com/accounts/settings'
    );
  }
  return { username, accessKey };
}

function browserStackCaps({ cycleId } = {}) {
  const { username, accessKey } = browserStackCredentials();
  const build = cycleId
    ? `QA-${cycleId}-${new Date().toISOString().split('T')[0]}`
    : `QA-Run-${new Date().toISOString().split('T')[0]}`;

  return {
    browser: 'chrome',
    browser_version: 'latest',
    os: 'Windows',
    os_version: '11',
    name: cycleId ? `Shopify QA ${cycleId}` : 'Shopify QA Regression',
    build,
    'browserstack.username': username,
    'browserstack.accessKey': accessKey,
    'browserstack.networkLogs': true,
    'browserstack.consoleLogs': 'info',
    // Required — version mismatch causes CDP socket disconnects on BrowserStack
    'client.playwrightVersion': PLAYWRIGHT_VERSION,
    'browserstack.playwrightVersion': '1.latest',
  };
}

function browserStackCdpUrl(caps) {
  return `wss://cdp.browserstack.com/playwright?caps=${encodeURIComponent(JSON.stringify(caps))}`;
}

function extractBrowserStackSessionId(browser) {
  try {
    const url =
      browser?._connection?._url ??
      browser?._connection?._transport?._wsURL ??
      browser?._connection?._transport?._ws?._url ??
      '';
    const match = String(url).match(/session\/([^/?]+)/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function browserStackApiJson(path, method = 'GET', body) {
  const { username, accessKey } = browserStackCredentials();
  const payload = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.browserstack.com',
        path,
        method,
        auth: `${username}:${accessKey}`,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(data ? JSON.parse(data) : null);
          } catch {
            resolve(data);
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchSessionIdForBuild(buildName) {
  try {
    const builds = await browserStackApiJson('/automate/builds.json');
    if (!Array.isArray(builds)) return null;
    const match = builds.find((b) => b.automation_build?.name === buildName);
    return match?.automation_build?.sessions?.[0]?.hashed_id ?? null;
  } catch (err) {
    console.warn('BrowserStack session lookup:', err.message);
    return null;
  }
}

/** Set session status via in-browser executor (works without session ID). */
export async function markBrowserStackSession(page, passed, reason) {
  if (!page) return;
  try {
    const payload = {
      action: 'setSessionStatus',
      arguments: {
        status: passed ? 'passed' : 'failed',
        reason: reason ?? (passed ? 'All tests passed' : 'One or more tests failed'),
      },
    };
    await page.evaluate(() => {}, `browserstack_executor: ${JSON.stringify(payload)}`);
  } catch (err) {
    console.warn('BrowserStack setSessionStatus:', err.message);
  }
}

/** Report overall pass/fail to BrowserStack Automate dashboard. */
export function updateBrowserStackStatus(sessionId, passed, reason) {
  return new Promise((resolve) => {
    if (!sessionId) return resolve();

    let username;
    let accessKey;
    try {
      ({ username, accessKey } = browserStackCredentials());
    } catch {
      return resolve();
    }

    const body = JSON.stringify({
      status: passed ? 'passed' : 'failed',
      reason: reason ?? (passed ? 'All tests passed' : 'One or more tests failed'),
    });

    const req = https.request(
      {
        hostname: 'api.browserstack.com',
        path: `/automate/sessions/${sessionId}.json`,
        method: 'PUT',
        auth: `${username}:${accessKey}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      () => resolve()
    );
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

function storeHandleFromUrl(storeUrl) {
  const url = storeUrl.replace(/\/$/, '');
  const adminMatch = url.match(/admin\.shopify\.com\/store\/([^/?#]+)/i);
  if (adminMatch) return adminMatch[1];
  const myshopifyMatch = url.match(/https?:\/\/([^.]+)\.myshopify\.com/i);
  if (myshopifyMatch) return myshopifyMatch[1];
  return null;
}

/** Canonical Shopify admin URL (preferred over legacy *.myshopify.com/admin). */
export function storeAdminUrl(storeUrl) {
  const handle = storeHandleFromUrl(storeUrl);
  if (handle) return `https://admin.shopify.com/store/${handle}`;
  const base = storeUrl.replace(/\/$/, '');
  return base.includes('/admin') ? base : `${base}/admin`;
}

/** Legacy myshopify admin — fallback when admin.shopify.com fails via proxy. */
export function storeAdminUrlLegacy(storeUrl) {
  const handle = storeHandleFromUrl(storeUrl);
  if (handle) return `https://${handle}.myshopify.com/admin`;
  const base = storeUrl.replace(/\/$/, '');
  if (/\.myshopify\.com/i.test(base)) {
    return base.includes('/admin') ? base : `${base}/admin`;
  }
  return storeAdminUrl(storeUrl);
}

export function isChromeErrorUrl(url) {
  return /^chrome-error:\/\//i.test(url ?? '');
}

export function isNavigationNetworkError(err) {
  const msg = String(err?.message ?? err);
  return /chrome-error|chromewebdata|interrupted by another navigation|ERR_(CONNECTION|NAME_NOT_RESOLVED|TIMED_OUT|SSL)/i.test(
    msg
  );
}

/**
 * Navigate with retries and alternate URLs when Steel/proxy hits chrome-error pages.
 */
export async function safeGoto(page, url, options = {}) {
  const {
    timeout = 60000,
    waitUntil = 'domcontentloaded',
    retries = 2,
    fallbacks = [],
  } = options;

  const targets = [...new Set([url, ...fallbacks].filter(Boolean))];
  let lastError;

  for (const target of targets) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        if (attempt > 0) console.log(`Retrying navigation to ${target} (attempt ${attempt + 1})`);
        else console.log(`Navigating to ${target}`);
        await page.goto(target, { waitUntil, timeout });
        if (isChromeErrorUrl(page.url())) {
          throw new Error(`Browser network error loading ${target}`);
        }
        return target;
      } catch (err) {
        lastError = err;
        if (!isNavigationNetworkError(err) && !isChromeErrorUrl(page.url())) {
          throw err;
        }
        console.warn(`Navigation failed (${target}): ${err.message}`);
        await page.waitForTimeout(2000 * (attempt + 1));
      }
    }
  }

  throw new Error(
    'Could not reach Shopify admin (browser network error). ' +
      'Re-export SHOPIFY_SESSION_COOKIES or retry. ' +
      `Last error: ${lastError?.message ?? 'unknown'}`
  );
}

const SAME_SITE_MAP = {
  strict: 'Strict',
  lax: 'Lax',
  none: 'None',
  no_restriction: 'None',
  unspecified: 'Lax',
  '': 'Lax',
};

export function normalizeCookiesForPlaywright(rawCookies) {
  return rawCookies
    .map((c) => {
      const name = c.name;
      const value = c.value ?? '';
      const domain = c.domain;
      if (!name || !domain) return null;

      const path = c.path || '/';
      const sameSiteKey = String(c.sameSite ?? '').toLowerCase();
      const sameSite = SAME_SITE_MAP[sameSiteKey] ?? 'Lax';

      const out = {
        name,
        value,
        domain,
        path,
        sameSite,
        httpOnly: Boolean(c.httpOnly),
        secure: Boolean(c.secure),
      };

      if (!c.session) {
        const exp = c.expires ?? c.expirationDate;
        if (typeof exp === 'number' && exp > 0) {
          out.expires = exp > 1e12 ? Math.floor(exp / 1000) : Math.floor(exp);
        }
      }

      return out;
    })
    .filter(Boolean);
}

function loadSessionCookies() {
  const raw = process.env.SHOPIFY_SESSION_COOKIES;
  if (!raw?.trim()) return null;

  const cookies = JSON.parse(raw);
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error('SHOPIFY_SESSION_COOKIES must be a non-empty JSON array');
  }
  const normalized = normalizeCookiesForPlaywright(cookies);
  if (normalized.length === 0) {
    throw new Error('No valid cookies in SHOPIFY_SESSION_COOKIES');
  }
  return normalized;
}

function emailInput(page) {
  return page
    .locator('input[type="email"]')
    .or(page.getByLabel(/email/i))
    .or(page.locator('input[name="account[email]"]'))
    .or(page.locator('#account_email'));
}

function passwordInput(page) {
  return page
    .locator('input[type="password"]')
    .or(page.getByLabel(/password/i))
    .or(page.locator('input[name="account[password]"]'))
    .or(page.locator('#account_password'));
}

export function isSessionExpired(url) {
  return /\/login|\/account\/login|accounts\.shopify\.com\/lookup|no_cookie_session/i.test(url);
}

export function isRemoteBrowserSessionError(err) {
  const msg = String(err?.message ?? err).toLowerCase();
  return /session.*timed?\s*out|websocket.*closed|target.*closed|browser has been closed|browser.*closed|cdp.*disconnect|protocol error.*target|connection.*closed.*browser/i.test(
    msg
  );
}

/** @deprecated Use isRemoteBrowserSessionError */
export const isSteelSessionError = isRemoteBrowserSessionError;

export function buildBrowserSessionLostMessage(appConfig, cycleId, completed, total, err) {
  const detail = err?.message ? `\nReason: ${err.message}` : '';
  return (
    `⚠️ BrowserStack session ended during *${appConfig.name}* — Cycle *${cycleId}*.\n` +
    `Completed ${completed} of ${total} test cases.${detail}\n` +
    `Check Automate → Sessions in the BrowserStack dashboard.`
  );
}

/** @deprecated Use buildBrowserSessionLostMessage */
export const buildSteelTimeoutMessage = buildBrowserSessionLostMessage;

export function buildLoginFailedMessage() {
  return (
    'Shopify login failed. Check SHOPIFY_ADMIN_EMAIL, SHOPIFY_ADMIN_PASSWORD, and SHOPIFY_2FA_SECRET — or set SHOPIFY_SESSION_COOKIES to skip login.'
  );
}

function usesBrowserStack() {
  return Boolean(
    process.env.BROWSERSTACK_USERNAME?.trim() && process.env.BROWSERSTACK_ACCESS_KEY?.trim()
  );
}

function hasShopifyCredentials() {
  return Boolean(
    process.env.SHOPIFY_ADMIN_EMAIL?.trim() && process.env.SHOPIFY_ADMIN_PASSWORD?.trim()
  );
}

export function resolveShopifyAuthMode() {
  const mode = process.env.SHOPIFY_AUTH_MODE?.trim().toLowerCase();
  if (mode === 'login' || mode === 'cookies') return mode;
  // Never use cookies on BrowserStack — IP-bound cf_clearance always fails
  if (usesBrowserStack()) return hasShopifyCredentials() ? 'login' : 'cookies';
  if (process.env.SHOPIFY_SESSION_COOKIES?.trim()) return 'cookies';
  return 'login';
}

export function buildCloudflareBlockedMessage(authMode) {
  const mode = authMode ?? resolveShopifyAuthMode();
  const onBs = usesBrowserStack();
  let msg = 'Cloudflare blocked Shopify admin access.\n\n';

  if (onBs && mode === 'login') {
    msg +=
      `Auth mode: email/password login (no cookies).\n\n` +
      'Cloudflare Turnstile blocked admin.shopify.com on BrowserStack.\n\n' +
      'Fix:\n' +
      '1. CAPSOLVER_API_KEY + CAPSOLVER_PROXY on Railway (browser + solver same IP)\n' +
      '2. SHOPIFY_ADMIN_EMAIL/PASSWORD/2FA on Railway\n' +
      '3. Or set CLOUDFLARE_MANUAL_WAIT_MS=120000 and click verify in BrowserStack live view\n';
    return msg;
  }

  if (onBs) {
    msg +=
      `Auth mode: ${mode}.\n\n` +
      'Cookies do not work on BrowserStack (cf_clearance is tied to your laptop IP).\n\n' +
      'Fix: remove SHOPIFY_SESSION_COOKIES everywhere and use SHOPIFY_ADMIN_EMAIL/PASSWORD instead.\n';
    return msg;
  }

  msg += 'Fix options:\n';
  msg += '1. Use SHOPIFY_ADMIN_EMAIL/PASSWORD login, or re-export fresh SHOPIFY_SESSION_COOKIES\n';
  if (!process.env.CAPSOLVER_API_KEY) {
    msg += '2. Set CAPSOLVER_API_KEY for automated Turnstile solving';
  } else {
    msg += '2. CapSolver could not bypass — try credential login instead of cookies';
  }
  return msg;
}

async function ensurePastCloudflare(page) {
  if (!(await isCloudflarePage(page))) return;

  console.log('Cloudflare Turnstile detected — bypassing…');
  const proxyCfg = getProxyConfig();
  const cleared = await bypassCloudflareOnPage(page, {
    useProxyChallenge: Boolean(proxyCfg && process.env.CAPSOLVER_API_KEY),
  });

  if (!cleared && (await isCloudflarePage(page))) {
    if (!process.env.CAPSOLVER_API_KEY?.trim()) {
      throw new Error(
        'Cloudflare blocked Shopify admin. Set CAPSOLVER_API_KEY on Railway to auto-solve Turnstile.'
      );
    }
    throw new Error(buildCloudflareBlockedMessage(resolveShopifyAuthMode()));
  }
}

async function isCloudflarePage(page) {
  const title = await page.title().catch(() => '');
  if (/just a moment|verify you are human|needs to be verified/i.test(title)) return true;
  const url = page.url();
  if (url.includes('__cf_chl') || url.includes('challenges.cloudflare.com')) return true;
  return page
    .getByText(/verify you are human|your connection needs to be verified/i)
    .first()
    .isVisible()
    .catch(() => false);
}

async function isAdminReady(page) {
  if (await isCloudflarePage(page)) return false;
  const url = page.url();
  if (!/admin\.shopify\.com\/store\//i.test(url) && !/\.myshopify\.com\/admin/i.test(url)) {
    return false;
  }
  return !(await emailInput(page).first().isVisible().catch(() => false));
}

async function generateTotpCode() {
  const secret = process.env.SHOPIFY_2FA_SECRET?.replace(/\s+/g, '');
  if (!secret) {
    throw new Error('SHOPIFY_2FA_SECRET is required when Shopify prompts for 2FA');
  }
  return generateTotp({ secret });
}

async function handleTwoFactor(page) {
  const codeInput = page
    .getByLabel(/authentication code|verification code|authenticator|security code|2fa|two-factor/i)
    .or(page.locator('input[name*="code" i]'))
    .or(page.locator('input[autocomplete="one-time-code"]'))
    .or(page.locator('input[inputmode="numeric"]'))
    .or(page.locator('input[maxlength="6"]'));

  const visible = await codeInput
    .first()
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);

  if (!visible) return;

  const useAppBtn = page.getByRole('button', {
    name: /authenticator app|authentication app|use.*app/i,
  });
  if (await useAppBtn.isVisible().catch(() => false)) {
    await useAppBtn.click();
    await codeInput.first().waitFor({ state: 'visible', timeout: 8000 });
  }

  await codeInput.first().fill(await generateTotpCode());
  await page
    .getByRole('button', { name: /verify|continue|log in|sign in|submit/i })
    .or(page.locator('button[type="submit"]'))
    .first()
    .click();
}

async function loginWithCredentials(page, email, password) {
  await page.goto('https://accounts.shopify.com/lookup', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForTimeout(1500);

  await ensurePastCloudflare(page);

  if (!(await emailInput(page).first().isVisible().catch(() => false))) {
    throw new Error('Could not find Shopify email field on login page');
  }

  await emailInput(page).first().fill(email);
  await page
    .getByRole('button', { name: /continue|next|log in|sign in/i })
    .or(page.locator('button[type="submit"]'))
    .first()
    .click();

  await passwordInput(page).first().waitFor({ state: 'visible', timeout: 30000 });
  await passwordInput(page).first().fill(password);
  await page
    .getByRole('button', { name: /log in|sign in|continue/i })
    .or(page.locator('button[type="submit"]'))
    .first()
    .click();

  await handleTwoFactor(page);

  await page
    .waitForURL(/admin\.shopify\.com|\.myshopify\.com\/admin/, { timeout: 90000 })
    .catch(() => {});

  await page.waitForTimeout(2000);
  await ensurePastCloudflare(page);
}

export async function createBrowser(options = {}) {
  const caps = browserStackCaps(options);
  console.log(
    `Connecting to BrowserStack Automate (${caps.os} ${caps.os_version}, ${caps.browser}, ` +
      `playwright=${PLAYWRIGHT_VERSION}, build=${caps.build})…`
  );

  const browser = await chromium.connect({
    wsEndpoint: browserStackCdpUrl(caps),
    timeout: 120_000,
  });

  const proxyCfg = getProxyConfig();
  if (proxyCfg?.playwright) {
    console.log(`BrowserStack context using residential proxy ${proxyCfg.playwright.server}`);
  }

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(proxyCfg?.playwright ? { proxy: proxyCfg.playwright } : {}),
  });
  const page = await context.newPage();

  let sessionId = extractBrowserStackSessionId(browser);
  if (!sessionId) {
    await page.waitForTimeout(2000);
    sessionId = await fetchSessionIdForBuild(caps.build);
  }

  if (sessionId) {
    console.log(`BrowserStack session: ${sessionId}`);
  } else {
    console.log('BrowserStack session connected (watch live in Automate → Sessions)');
  }

  return { browser, context, page, sessionId, buildName: caps.build };
}

export const launchBrowser = createBrowser;

async function openShopifyAdminWithCookies(context, page, appConfig) {
  const cookies = loadSessionCookies();
  await context.addCookies(cookies);

  const adminUrl = storeAdminUrl(appConfig.store_url);
  const legacyUrl = storeAdminUrlLegacy(appConfig.store_url);

  console.log(`Opening admin with session cookies: ${adminUrl}`);
  await safeGoto(page, adminUrl, { fallbacks: [legacyUrl] });
  await page.waitForTimeout(2000);

  await ensurePastCloudflare(page);

  if (!(await isAdminReady(page))) {
    throw new Error(
      'Session cookies expired or invalid. Re-export SHOPIFY_SESSION_COOKIES from the dev store admin.'
    );
  }
  console.log('Shopify admin ready (cookies)');
}

export async function loginToShopify(page, appConfig) {
  const adminUrl = storeAdminUrl(appConfig.store_url);
  const legacyUrl = storeAdminUrlLegacy(appConfig.store_url);

  const email = process.env.SHOPIFY_ADMIN_EMAIL?.trim();
  const password = process.env.SHOPIFY_ADMIN_PASSWORD?.trim();
  if (!email || !password) {
    throw new Error('SHOPIFY_ADMIN_EMAIL and SHOPIFY_ADMIN_PASSWORD are required');
  }

  // Go straight to accounts login — avoid hitting admin URL (triggers Cloudflare on cold IP)
  console.log('Logging into Shopify via accounts.shopify.com…');
  await loginWithCredentials(page, email, password);

  if (await isAdminReady(page)) {
    console.log('Shopify admin ready after login');
    return;
  }

  if (!/admin\.shopify\.com\/store\//i.test(page.url())) {
    await safeGoto(page, adminUrl, { fallbacks: [legacyUrl] });
    await page.waitForTimeout(2000);
    await ensurePastCloudflare(page);
  } else if (await isCloudflarePage(page)) {
    await ensurePastCloudflare(page);
  }

  if (!(await isAdminReady(page))) {
    throw new Error(buildLoginFailedMessage());
  }

  console.log('Shopify admin login successful');
}

/**
 * Open Shopify admin — login preferred on BrowserStack (cookies are IP-bound).
 * SHOPIFY_AUTH_MODE: login | cookies | auto (default)
 */
export async function openShopifyAdmin(context, page, appConfig) {
  const mode = resolveShopifyAuthMode();
  console.log(`Shopify auth mode: ${mode}`);

  if (mode === 'login') {
    if (!hasShopifyCredentials()) {
      throw new Error(
        'SHOPIFY_ADMIN_EMAIL and SHOPIFY_ADMIN_PASSWORD are required for BrowserStack login'
      );
    }
    await loginToShopify(page, appConfig);
    return;
  }

  if (!process.env.SHOPIFY_SESSION_COOKIES?.trim()) {
    await loginToShopify(page, appConfig);
    return;
  }

  try {
    await openShopifyAdminWithCookies(context, page, appConfig);
  } catch (err) {
    const retryWithLogin =
      hasShopifyCredentials() &&
      /cloudflare|session cookies expired|invalid/i.test(String(err?.message ?? ''));
    if (!retryWithLogin) throw err;
    console.warn('Cookie auth failed — falling back to credential login…');
    await loginToShopify(page, appConfig);
  }
}

export async function closeBrowser(handle) {
  if (!handle) return;

  const { browser } = handle.browser !== undefined ? handle : { browser: handle };
  if (browser) {
    await browser.close().catch(() => {});
  }
}

export async function getSessionBlockReason(page, appConfig) {
  if (await isCloudflarePage(page)) {
    return buildCloudflareBlockedMessage(resolveShopifyAuthMode());
  }
  const url = page.url();
  if (isSessionExpired(url) || !(await isAdminReady(page))) {
    return buildLoginFailedMessage();
  }
  return null;
}

export async function assertReadyForTests(page, appConfig) {
  const reason = await getSessionBlockReason(page, appConfig);
  if (reason) throw new Error(reason);
}
