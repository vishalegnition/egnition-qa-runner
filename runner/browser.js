import Steel from 'steel-sdk';
import { chromium } from 'playwright';
import { generate as generateTotp } from 'otplib';

const STEEL_SESSION_TIMEOUT_MS = Number(process.env.STEEL_SESSION_TIMEOUT_MS) || 900_000;

function storeHandleFromUrl(storeUrl) {
  const url = storeUrl.replace(/\/$/, '');
  const adminMatch = url.match(/admin\.shopify\.com\/store\/([^/?#]+)/i);
  if (adminMatch) return adminMatch[1];
  const myshopifyMatch = url.match(/https?:\/\/([^.]+)\.myshopify\.com/i);
  if (myshopifyMatch) return myshopifyMatch[1];
  return null;
}

/** Prefer myshopify.com/admin for direct store access. */
export function storeAdminUrl(storeUrl) {
  const base = storeUrl.replace(/\/$/, '');
  if (/\.myshopify\.com/i.test(base)) {
    return base.includes('/admin') ? base : `${base}/admin`;
  }
  const handle = storeHandleFromUrl(storeUrl);
  if (handle) return `https://${handle}.myshopify.com/admin`;
  return base.includes('/admin') ? base : `${base}/admin`;
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
  return /steel|session.*timeout|session.*released|websocket.*closed|cdp.*disconnect/i.test(msg);
}

export function buildSteelTimeoutMessage(appConfig, cycleId, completed, total) {
  return (
    `⚠️ Steel.dev session timed out during *${appConfig.name}* — Cycle *${cycleId}*.\n` +
    `Completed ${completed} of ${total} test cases before timeout.\n` +
    `Partial results above. Re-run the cycle to continue.`
  );
}

export function buildLoginFailedMessage() {
  return (
    'Shopify login failed. Check SHOPIFY_ADMIN_EMAIL, SHOPIFY_ADMIN_PASSWORD, and SHOPIFY_2FA_SECRET in Railway/GitHub secrets.'
  );
}

async function isAdminReady(page) {
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
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  if (!visible) return;

  const useAppBtn = page.getByRole('button', {
    name: /authenticator app|authentication app|use.*app/i,
  });
  if (await useAppBtn.isVisible().catch(() => false)) {
    await useAppBtn.click();
    await codeInput.first().waitFor({ state: 'visible', timeout: 10000 });
  }

  const code = await generateTotpCode();
  await codeInput.first().fill(code);

  await page
    .getByRole('button', { name: /verify|continue|log in|sign in|submit/i })
    .or(page.locator('button[type="submit"]'))
    .first()
    .click();
}

async function loginWithCredentials(page, email, password) {
  const loginUrls = [
    'https://accounts.shopify.com/lookup',
    'https://admin.shopify.com/login',
  ];

  let onLoginPage = false;
  for (const loginUrl of loginUrls) {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(2000);

    if (await emailInput(page).first().isVisible().catch(() => false)) {
      onLoginPage = true;
      break;
    }
  }

  if (!onLoginPage) {
    throw new Error('Could not find Shopify email field on login page');
  }

  await emailInput(page).first().fill(email);
  await page
    .getByRole('button', { name: /continue|next|log in|sign in/i })
    .or(page.locator('button[type="submit"]'))
    .first()
    .click();

  await passwordInput(page).first().waitFor({ state: 'visible', timeout: 45000 });
  await passwordInput(page).first().fill(password);
  await page
    .getByRole('button', { name: /log in|sign in|continue/i })
    .or(page.locator('button[type="submit"]'))
    .first()
    .click();

  await handleTwoFactor(page);

  await page
    .waitForURL(/admin\.shopify\.com|accounts\.shopify\.com|\.myshopify\.com/, {
      timeout: 120000,
    })
    .catch(() => {});
}

/**
 * Create a Steel.dev cloud browser session and connect Playwright via CDP.
 */
export async function createBrowser() {
  const apiKey = process.env.STEEL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('STEEL_API_KEY is required — get one from https://steel.dev');
  }

  const steel = new Steel({ steelAPIKey: apiKey });

  const solveCaptcha = process.env.STEEL_SOLVE_CAPTCHA === 'true';
  console.log(
    `Creating Steel.dev session (proxy=${true}, captcha=${solveCaptcha})…`
  );

  const sessionParams = {
    useProxy: true,
    timeout: STEEL_SESSION_TIMEOUT_MS,
    dimensions: { width: 1440, height: 900 },
  };
  if (solveCaptcha) sessionParams.solveCaptcha = true;

  const session = await steel.sessions.create(sessionParams);

  console.log(`Steel session ${session.id} — viewer: ${session.sessionViewerUrl}`);

  const browser = await chromium.connectOverCDP(`${session.websocketUrl}&apiKey=${apiKey}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  return { browser, context, page, session, steel };
}

/** @deprecated Use createBrowser — kept for compatibility */
export const launchBrowser = createBrowser;

export async function loginToShopify(page, appConfig) {
  const adminUrl = storeAdminUrl(appConfig.store_url);
  console.log(`Navigating to ${adminUrl}`);
  await page.goto(adminUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(3000);

  if (await isAdminReady(page)) {
    console.log('Shopify admin already loaded');
    return;
  }

  const email = process.env.SHOPIFY_ADMIN_EMAIL?.trim();
  const password = process.env.SHOPIFY_ADMIN_PASSWORD?.trim();
  if (!email || !password) {
    throw new Error('SHOPIFY_ADMIN_EMAIL and SHOPIFY_ADMIN_PASSWORD are required');
  }

  console.log('Logging into Shopify…');
  await loginWithCredentials(page, email, password);

  await page.goto(adminUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(3000);

  if (!(await isAdminReady(page))) {
    throw new Error(buildLoginFailedMessage());
  }

  console.log('Shopify admin login successful');
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
