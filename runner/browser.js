import Steel from 'steel-sdk';
import { chromium } from 'playwright';
import { generate as generateTotp } from 'otplib';
import { solveTurnstileOnPage, solveCloudflareChallenge } from './capsolver.js';
import { getSteelProxyUrl } from './proxy.js';

/** Hobby plan max = 15 min. Starter+ can set higher via env. */
const STEEL_SESSION_TIMEOUT_MS = Number(process.env.STEEL_SESSION_TIMEOUT_MS) || 900_000;

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
      'Check CAPSOLVER_PROXY connectivity on Railway, or re-export SHOPIFY_SESSION_COOKIES. ' +
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

export function isSteelSessionError(err) {
  const msg = String(err?.message ?? err).toLowerCase();
  return /session.*timed?\s*out|session.*released|websocket.*closed|target.*closed|browser.*closed|cdp.*disconnect|connection.*closed|protocol error|session expired/i.test(
    msg
  );
}

export function buildSteelTimeoutMessage(appConfig, cycleId, completed, total) {
  return (
    `⚠️ Steel.dev session ended during *${appConfig.name}* — Cycle *${cycleId}*.\n` +
    `Completed ${completed} of ${total} test cases.\n` +
    `Hobby plan sessions last max 15 minutes. If login was slow, set SHOPIFY_SESSION_COOKIES to skip login, or upgrade Steel for longer sessions + proxy/captcha.`
  );
}

export function buildLoginFailedMessage() {
  return (
    'Shopify login failed. Check SHOPIFY_ADMIN_EMAIL, SHOPIFY_ADMIN_PASSWORD, and SHOPIFY_2FA_SECRET — or set SHOPIFY_SESSION_COOKIES to skip login.'
  );
}

export function buildCloudflareBlockedMessage() {
  const hasCapsolver = Boolean(process.env.CAPSOLVER_API_KEY);
  const hasProxy = Boolean(process.env.CAPSOLVER_PROXY);
  let msg = 'Cloudflare blocked Shopify admin access.\n\nFix options:\n';
  msg += '1. Re-export SHOPIFY_SESSION_COOKIES from https://dailyshop-fuehd07p.myshopify.com/admin (include cf_clearance)\n';
  if (!hasCapsolver) {
    msg += '2. Set CAPSOLVER_API_KEY on Railway for automated Turnstile solving';
  } else if (!hasProxy) {
    msg += '2. Set CAPSOLVER_PROXY (SOAX/residential) for full Cloudflare interstitial bypass';
  } else {
    msg += '2. CapSolver could not solve — try fresh cookies or upgrade Steel (STEEL_SOLVE_CAPTCHA=true)';
  }
  return msg;
}

async function tryBypassCloudflare(page) {
  if (!process.env.CAPSOLVER_API_KEY) return false;
  console.log('Cloudflare detected — trying CapSolver…');

  let solved = false;
  try {
    solved = await solveTurnstileOnPage(page);
  } catch (err) {
    console.warn('CapSolver Turnstile:', err.message);
  }

  if (!solved && process.env.CAPSOLVER_PROXY) {
    try {
      solved = await solveCloudflareChallenge(page);
    } catch (err) {
      console.warn('CapSolver Challenge:', err.message);
    }
  }

  if (solved) {
    await page.waitForTimeout(3000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
  return solved;
}

async function ensurePastCloudflare(page) {
  for (let attempt = 0; attempt < 2 && (await isCloudflarePage(page)); attempt++) {
    if (!(await tryBypassCloudflare(page))) break;
  }
  if (await isCloudflarePage(page)) {
    throw new Error(buildCloudflareBlockedMessage());
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

  if (await isCloudflarePage(page)) {
    throw new Error(buildCloudflareBlockedMessage());
  }

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
    .waitForURL(/admin\.shopify\.com|\.myshopify\.com\/admin/, { timeout: 60000 })
    .catch(() => {});
}

export async function createBrowser() {
  const apiKey = process.env.STEEL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('STEEL_API_KEY is required — get one from https://steel.dev');
  }

  const steel = new Steel({ steelAPIKey: apiKey });
  const useProxy = process.env.STEEL_USE_PROXY === 'true';
  const solveCaptcha = process.env.STEEL_SOLVE_CAPTCHA === 'true';

  console.log(
    `Creating Steel.dev session (timeout=${STEEL_SESSION_TIMEOUT_MS}ms, proxy=${useProxy}, captcha=${solveCaptcha})…`
  );

  const sessionParams = {
    timeout: STEEL_SESSION_TIMEOUT_MS,
    dimensions: { width: 1440, height: 900 },
  };

  const externalProxy = getSteelProxyUrl();
  if (externalProxy) {
    sessionParams.proxyUrl = externalProxy;
    console.log('Steel session using CAPSOLVER_PROXY as external proxy');
  } else if (useProxy) {
    sessionParams.useProxy = true;
  }
  if (solveCaptcha) sessionParams.solveCaptcha = true;

  const session = await steel.sessions.create(sessionParams);
  console.log(`Steel session ${session.id} — viewer: ${session.sessionViewerUrl}`);

  const browser = await chromium.connectOverCDP(`${session.websocketUrl}&apiKey=${apiKey}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  return { browser, context, page, session, steel };
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
  await safeGoto(page, adminUrl, { fallbacks: [legacyUrl] });
  await page.waitForTimeout(2000);

  if (await isAdminReady(page)) {
    console.log('Shopify admin already loaded');
    return;
  }

  await ensurePastCloudflare(page);

  const email = process.env.SHOPIFY_ADMIN_EMAIL?.trim();
  const password = process.env.SHOPIFY_ADMIN_PASSWORD?.trim();
  if (!email || !password) {
    throw new Error('SHOPIFY_ADMIN_EMAIL and SHOPIFY_ADMIN_PASSWORD are required');
  }

  console.log('Logging into Shopify…');
  await loginWithCredentials(page, email, password);

  await safeGoto(page, adminUrl, { fallbacks: [legacyUrl] });
  await page.waitForTimeout(2000);

  await ensurePastCloudflare(page);

  if (!(await isAdminReady(page))) {
    throw new Error(buildLoginFailedMessage());
  }

  console.log('Shopify admin login successful');
}

/** Cookies if SHOPIFY_SESSION_COOKIES is set, otherwise email/password login. */
export async function openShopifyAdmin(context, page, appConfig) {
  if (process.env.SHOPIFY_SESSION_COOKIES?.trim()) {
    await openShopifyAdminWithCookies(context, page, appConfig);
  } else {
    await loginToShopify(page, appConfig);
  }
}

export async function closeBrowser(handle) {
  if (!handle) return;

  const { browser, steel, session } =
    handle.browser !== undefined ? handle : { browser: handle, steel: null, session: null };

  if (browser) {
    await browser.close().catch(() => {});
  }
  if (steel && session?.id) {
    await steel.sessions.release(session.id).catch((err) => {
      console.warn('Steel session release:', err.message);
    });
  }
}

export async function getSessionBlockReason(page, appConfig) {
  if (await isCloudflarePage(page)) {
    return buildCloudflareBlockedMessage();
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
