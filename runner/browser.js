import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright';
import { generate as generateTotp } from 'otplib';

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
      'SHOPIFY_STORAGE_STATE is invalid. Regenerate with: node scripts/shopify-save-session.js'
    );
  }
}

async function detectCloudflare(page) {
  const title = await page.title().catch(() => '');
  const url = page.url();
  if (
    /just a moment|verifying your connection|attention required/i.test(title) ||
    url.includes('__cf_chl') ||
    url.includes('challenges.cloudflare.com')
  ) {
    return true;
  }
  const turnstile = await page.locator('input[name="cf-turnstile-response"]').count();
  return turnstile > 0 && (await page.locator('input[type="email"], #account_email').count()) === 0;
}

async function throwIfCloudflare(page) {
  if (await detectCloudflare(page)) {
    throw new Error(
      'Shopify blocked automated login (Cloudflare challenge). Save a browser session once with: node scripts/shopify-save-session.js — then add the output as GitHub secret SHOPIFY_STORAGE_STATE.'
    );
  }
}

/**
 * Launch headed Chromium (use Xvfb on CI: DISPLAY=:99).
 */
export async function launchBrowser() {
  const storageState = loadStorageState();

  const browser = await chromium.launch({
    headless: HEADLESS,
    channel: 'chromium',
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(HEADLESS ? [] : ['--no-sandbox', '--disable-setuid-sandbox']),
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
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

async function isAdminReady(page) {
  const url = page.url();
  return /admin\.shopify\.com\/store\//i.test(url) || /\.myshopify\.com\/admin/i.test(url);
}

async function openStoreAdmin(page, storeUrl) {
  const handle = storeHandleFromUrl(storeUrl);
  const target = handle
    ? `https://admin.shopify.com/store/${handle}`
    : storeUrl.replace(/\/$/, '').includes('/admin')
      ? storeUrl
      : `${storeUrl.replace(/\/$/, '')}/admin`;

  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2000);
  await throwIfCloudflare(page);
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
    await throwIfCloudflare(page);

    const emailVisible = await emailInput(page)
      .first()
      .isVisible()
      .catch(() => false);
    if (emailVisible) {
      onLoginPage = true;
      break;
    }
  }

  if (!onLoginPage) {
    await throwIfCloudflare(page);
    throw new Error(
      'Could not find Shopify email field. Cloudflare may be blocking CI login — set SHOPIFY_STORAGE_STATE (see scripts/shopify-save-session.js).'
    );
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

  await page.waitForURL(/admin\.shopify\.com|accounts\.shopify\.com|\.myshopify\.com/, {
    timeout: 120000,
  }).catch(() => {});
}

/**
 * Log in to Shopify admin for the given store URL.
 */
export async function loginToShopify(page, storeUrl, { hasStorageState = false } = {}) {
  await openStoreAdmin(page, storeUrl);

  if (await isAdminReady(page)) {
    const onLogin = await emailInput(page).first().isVisible().catch(() => false);
    if (!onLogin) return;
  }

  if (hasStorageState) {
    await page.waitForTimeout(3000);
    if (await isAdminReady(page)) {
      const onLogin = await emailInput(page).first().isVisible().catch(() => false);
      if (!onLogin) return;
    }
  }

  const email = process.env.SHOPIFY_ADMIN_EMAIL;
  const password = process.env.SHOPIFY_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error('SHOPIFY_ADMIN_EMAIL and SHOPIFY_ADMIN_PASSWORD are required');
  }

  await loginWithCredentials(page, email, password);
  await openStoreAdmin(page, storeUrl);

  const stillOnLogin = await emailInput(page).first().isVisible().catch(() => false);
  if (stillOnLogin || !(await isAdminReady(page))) {
    await throwIfCloudflare(page);
    throw new Error(
      'Shopify login failed. Check credentials/2FA, store URL in config/apps.json, or set SHOPIFY_STORAGE_STATE.'
    );
  }
}

export async function closeBrowser(browser) {
  if (browser) {
    await browser.close().catch(() => {});
  }
}
