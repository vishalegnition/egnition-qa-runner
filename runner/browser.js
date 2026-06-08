import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'patchright';
import { generate as generateTotp } from 'otplib';
import { solveTurnstileOnPage, solveCloudflareChallenge } from './capsolver.js';

// Headed mode required for Cloudflare — Xvfb on CI provides a virtual display.
const HEADLESS = process.env.PLAYWRIGHT_HEADLESS === 'true';

function storeHandleFromUrl(storeUrl) {
  const url = storeUrl.replace(/\/$/, '');
  const adminMatch = url.match(/admin\.shopify\.com\/store\/([^/?#]+)/i);
  if (adminMatch) return adminMatch[1];
  const myshopifyMatch = url.match(/https?:\/\/([^.]+)\.myshopify\.com/i);
  if (myshopifyMatch) return myshopifyMatch[1];
  return null;
}

function loadStorageState() {
  const raw = process.env.SHOPIFY_STORAGE_STATE;
  if (!raw?.trim()) return undefined;

  try {
    const json = Buffer.from(raw.trim(), 'base64').toString('utf8');
    const state = JSON.parse(json);
    const tmp = path.join(os.tmpdir(), `shopify-state-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(state));
    return tmp;
  } catch {
    throw new Error(
      'SHOPIFY_STORAGE_STATE is invalid. Regenerate with: npm run shopify:session'
    );
  }
}

function emailInput(page) {
  return page
    .locator('input[type="email"]')
    .or(page.getByLabel(/email/i))
    .or(page.locator('input[name="account[email]"]'))
    .or(page.locator('#account_email'))
    .or(page.locator('input[name="email"]'));
}

function passwordInput(page) {
  return page
    .locator('input[type="password"]')
    .or(page.getByLabel(/password/i))
    .or(page.locator('input[name="account[password]"]'))
    .or(page.locator('#account_password'));
}

async function isCloudflarePage(page) {
  const title = await page.title().catch(() => '');
  const url = page.url();
  if (/just a moment|verifying your connection|attention required|something went wrong/i.test(title)) {
    return true;
  }
  if (url.includes('__cf_chl') || url.includes('challenges.cloudflare.com')) {
    return true;
  }
  const hasTurnstile = (await page.locator('input[name="cf-turnstile-response"]').count()) > 0;
  const hasEmail = (await emailInput(page).count()) > 0;
  return hasTurnstile && !hasEmail;
}

async function isLoginReady(page) {
  if (await emailInput(page).first().isVisible().catch(() => false)) return true;
  return /log in.*shopify/i.test(await page.title().catch(() => ''));
}

async function isAdminReady(page) {
  const url = page.url();
  if (!/admin\.shopify\.com\/store\//i.test(url) && !/\.myshopify\.com\/admin/i.test(url)) {
    return false;
  }
  return !(await emailInput(page).first().isVisible().catch(() => false));
}

/**
 * Wait for Cloudflare to clear. Tries CapSolver if configured; never claims auto-pass.
 */
async function waitPastCloudflare(page, label = 'page') {
  const maxMs = Number(process.env.CLOUDFLARE_WAIT_MS || 90000);
  const start = Date.now();
  let capsolverTried = false;

  while (Date.now() - start < maxMs) {
    if (await isLoginReady(page)) {
      console.log(`Cloudflare cleared — ${label} login form visible`);
      return;
    }
    if (await isAdminReady(page)) {
      console.log(`Already on admin — ${label}`);
      return;
    }

    if (await isCloudflarePage(page)) {
      if (!capsolverTried && process.env.CAPSOLVER_API_KEY) {
        capsolverTried = true;
        console.log(`Cloudflare detected on ${label} — trying CapSolver...`);
        await solveTurnstileOnPage(page).catch(() => false);
        if (!(await isLoginReady(page)) && !(await isAdminReady(page))) {
          await solveCloudflareChallenge(page).catch((e) =>
            console.warn('CapSolver cloudflare task:', e.message)
          );
        }
        continue;
      }
      console.log(`Waiting for Cloudflare (${label})... ${Math.round((Date.now() - start) / 1000)}s`);
    }

    await page.waitForTimeout(3000);
  }

  if (await isLoginReady(page) || await isAdminReady(page)) return;

  const hasCapsolver = Boolean(process.env.CAPSOLVER_API_KEY);
  const hasSession = Boolean(process.env.SHOPIFY_STORAGE_STATE?.trim());

  let msg =
    'Cloudflare blocked Shopify login. A human must solve it once, or use an automated solver.\n\n' +
    'Option A (free): npm run shopify:session — you click through Cloudflare in the browser, then npm run shopify:upload\n' +
    'Option B (automated): add CAPSOLVER_API_KEY to GitHub secrets (paid Turnstile solver)';

  if (!hasSession && !hasCapsolver) {
    msg += '\n\nNeither SHOPIFY_STORAGE_STATE nor CAPSOLVER_API_KEY is configured.';
  }

  throw new Error(msg);
}

/**
 * Launch browser via Patchright (anti-detection) + real Chrome on CI.
 */
export async function launchBrowser() {
  const storageState = loadStorageState();

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
    ...(storageState ? { storageState } : {}),
  });

  const page = await context.newPage();
  return { browser, context, page, hasStorageState: Boolean(storageState) };
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

async function openStoreAdmin(page, storeUrl) {
  const handle = storeHandleFromUrl(storeUrl);
  const target = handle
    ? `https://admin.shopify.com/store/${handle}`
    : storeUrl.replace(/\/$/, '').includes('/admin')
      ? storeUrl
      : `${storeUrl.replace(/\/$/, '')}/admin`;

  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await waitPastCloudflare(page, 'admin');
}

async function loginWithCredentials(page, email, password) {
  await page.goto('https://accounts.shopify.com/lookup', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await waitPastCloudflare(page, 'login');

  await emailInput(page).first().waitFor({ state: 'visible', timeout: 30000 });
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

  await page.waitForURL(/admin\.shopify\.com|\.myshopify\.com/, {
    timeout: 120000,
  }).catch(() => {});
}

export async function loginToShopify(page, storeUrl, { hasStorageState = false } = {}) {
  await openStoreAdmin(page, storeUrl);

  if (await isAdminReady(page)) return;

  if (hasStorageState) {
    await page.waitForTimeout(2000);
    if (await isAdminReady(page)) return;
  }

  const email = process.env.SHOPIFY_ADMIN_EMAIL;
  const password = process.env.SHOPIFY_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('SHOPIFY_ADMIN_EMAIL and SHOPIFY_ADMIN_PASSWORD are required');
  }

  await loginWithCredentials(page, email, password);
  await openStoreAdmin(page, storeUrl);

  if (!(await isAdminReady(page))) {
    throw new Error(
      'Shopify login failed after credentials. Check email/password/2FA and store URL in config/apps.json.'
    );
  }
}

export async function closeBrowser(browser) {
  if (browser) {
    await browser.close().catch(() => {});
  }
}
