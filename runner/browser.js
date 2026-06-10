import { chromium } from 'patchright';
import { solveTurnstileOnPage, solveCloudflareChallenge } from './capsolver.js';

const HEADLESS = process.env.PLAYWRIGHT_HEADLESS === 'true';

function storeHandleFromUrl(storeUrl) {
  const url = storeUrl.replace(/\/$/, '');
  const adminMatch = url.match(/admin\.shopify\.com\/store\/([^/?#]+)/i);
  if (adminMatch) return adminMatch[1];
  const myshopifyMatch = url.match(/https?:\/\/([^.]+)\.myshopify\.com/i);
  if (myshopifyMatch) return myshopifyMatch[1];
  return null;
}

/** Prefer myshopify.com/admin — fewer Cloudflare challenges than admin.shopify.com on CI. */
export function storeAdminUrl(storeUrl) {
  const base = storeUrl.replace(/\/$/, '');
  if (/\.myshopify\.com/i.test(base)) {
    return base.includes('/admin') ? base : `${base}/admin`;
  }
  const handle = storeHandleFromUrl(storeUrl);
  if (handle) return `https://${handle}.myshopify.com/admin`;
  return base.includes('/admin') ? base : `${base}/admin`;
}

const COOKIE_SECRET = 'SHOPIFY_SESSION_COOKIES';

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

export function loadSessionCookies() {
  const raw = process.env[COOKIE_SECRET];
  if (!raw?.trim()) {
    throw new Error(
      `Missing GitHub secret ${COOKIE_SECRET}. Log in to your dev store admin, export cookies via Cookie-Editor.`
    );
  }

  try {
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) {
      throw new Error('Cookie JSON must be a non-empty array');
    }
    const normalized = normalizeCookiesForPlaywright(cookies);
    if (normalized.length === 0) {
      throw new Error('No valid cookies after normalization — check Cookie-Editor export');
    }
    return normalized;
  } catch (err) {
    if (err.message?.includes('Cookie JSON')) throw err;
    throw new Error(
      `Invalid JSON in ${COOKIE_SECRET}. Export cookies via Cookie-Editor → Export as JSON.`
    );
  }
}

export function isSessionExpired(url) {
  return /\/login|\/account\/login|accounts\.shopify\.com|no_cookie_session/i.test(url);
}

export async function isCloudflarePage(page) {
  const title = await page.title().catch(() => '');
  const url = page.url();
  if (
    /just a moment|verify you are human|needs to be verified|verifying your connection|attention required/i.test(
      title
    )
  ) {
    return true;
  }
  if (url.includes('__cf_chl') || url.includes('challenges.cloudflare.com')) {
    return true;
  }
  const cfText = await page
    .getByText(/verify you are human|your connection needs to be verified/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (cfText) return true;
  const hasTurnstile =
    (await page.locator('input[name="cf-turnstile-response"]').count()) > 0;
  const hasEmail = (await page.locator('input[type="email"]').count()) > 0;
  return hasTurnstile && !hasEmail;
}

export function buildSessionExpiredMessage(appConfig) {
  const store = appConfig.store_url?.replace(/\/$/, '') ?? '[store]';
  const where = process.env.RUN_ON_RAILWAY === '1' ? 'Railway env var' : 'GitHub secret';
  return (
    `Shopify session expired (shared dev store).\n` +
    `Refresh ${COOKIE_SECRET} in ${where}.\n` +
    `Log in to ${store}/admin with "Remember me" → Cookie-Editor → Export as JSON.`
  );
}

export function buildCloudflareBlockedMessage() {
  const hasCapsolver = Boolean(process.env.CAPSOLVER_API_KEY);
  const onRailway = process.env.RUN_ON_RAILWAY === '1';

  let msg = onRailway
    ? 'Cloudflare blocked the Railway browser (Verify you are human).\n\nFix options:\n'
    : 'Cloudflare blocked the browser on GitHub Actions (datacenter IP).\n\nFix options:\n';

  msg +=
    '1. Re-export SHOPIFY_SESSION_COOKIES while logged in on the dev store admin\n' +
    '2. Add CAPSOLVER_API_KEY for automated Turnstile solving';

  if (!onRailway) {
    msg += '\n3. Tests now run on Railway by default — use /run-tests in Slack (not GitHub Actions)';
  }

  if (!hasCapsolver) {
    msg += '\n\nCAPSOLVER_API_KEY is not configured.';
  }
  return msg;
}

function emailInput(page) {
  return page
    .locator('input[type="email"]')
    .or(page.getByLabel(/email/i))
    .or(page.locator('input[name="account[email]"]'));
}

async function isAdminReady(page) {
  if (await isCloudflarePage(page)) return false;
  const url = page.url();
  if (!/admin\.shopify\.com\/store\//i.test(url) && !/\.myshopify\.com\/admin/i.test(url)) {
    return false;
  }
  return !(await emailInput(page).first().isVisible().catch(() => false));
}

async function tryBypassCloudflare(page) {
  if (!process.env.CAPSOLVER_API_KEY) return false;
  console.log('Cloudflare detected — trying CapSolver...');
  const solved =
    (await solveTurnstileOnPage(page).catch(() => false)) ||
    (await solveCloudflareChallenge(page).catch(() => false));
  if (solved) await page.waitForTimeout(3000);
  return solved;
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

export async function openShopifyAdminWithCookies(context, page, appConfig) {
  const cookies = loadSessionCookies();
  await context.addCookies(cookies);

  const storeBase = appConfig.store_url.replace(/\/$/, '');
  const adminUrl = storeAdminUrl(appConfig.store_url);

  console.log(`Warming session at ${storeBase}`);
  await page.goto(storeBase, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});

  console.log(`Navigating to ${adminUrl} with injected cookies`);
  await page.goto(adminUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2000);

  for (let attempt = 0; attempt < 2 && (await isCloudflarePage(page)); attempt++) {
    const solved = await tryBypassCloudflare(page);
    if (!solved) break;
    await page.waitForTimeout(2000);
  }

  if (await isCloudflarePage(page)) {
    throw new Error(buildCloudflareBlockedMessage());
  }

  if (isSessionExpired(page.url()) || !(await isAdminReady(page))) {
    throw new Error(buildSessionExpiredMessage(appConfig));
  }

  console.log('Shopify admin session valid');
}

export async function closeBrowser(browser) {
  if (browser) {
    await browser.close().catch(() => {});
  }
}

export async function getSessionBlockReason(page, appConfig) {
  if (await isCloudflarePage(page)) {
    const solved = await tryBypassCloudflare(page);
    if (solved && !(await isCloudflarePage(page))) return null;
    return buildCloudflareBlockedMessage();
  }
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
