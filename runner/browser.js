import { chromium } from 'playwright';
import { authenticator } from 'otplib';

const HEADLESS = process.env.PLAYWRIGHT_HEADLESS === 'true';

/**
 * Launch headed Chromium (use Xvfb on CI: DISPLAY=:99).
 */
export async function launchBrowser() {
  const browser = await chromium.launch({
    headless: HEADLESS,
    channel: 'chromium',
    args: HEADLESS ? [] : ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();
  return { browser, context, page };
}

function generateTotpCode() {
  const secret = process.env.SHOPIFY_2FA_SECRET?.replace(/\s+/g, '');
  if (!secret) {
    throw new Error('SHOPIFY_2FA_SECRET is required when Shopify prompts for 2FA');
  }
  return authenticator.generate(secret);
}

/**
 * Handle Shopify TOTP 2FA if the verification step appears.
 */
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

  const code = generateTotpCode();
  await codeInput.first().fill(code);

  await page
    .getByRole('button', { name: /verify|continue|log in|sign in|submit/i })
    .or(page.locator('button[type="submit"]'))
    .first()
    .click();
}

/**
 * Log in to Shopify admin for the given store URL.
 */
export async function loginToShopify(page, storeUrl) {
  const email = process.env.SHOPIFY_ADMIN_EMAIL;
  const password = process.env.SHOPIFY_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error('SHOPIFY_ADMIN_EMAIL and SHOPIFY_ADMIN_PASSWORD are required');
  }

  const base = storeUrl.replace(/\/$/, '');
  const adminUrl = base.includes('/admin')
    ? base
    : `${base}/admin`;

  await page.goto(adminUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const emailInput = page
    .getByLabel(/email/i)
    .or(page.locator('input[name="account[email]"]'))
    .or(page.locator('#account_email'));

  await emailInput.first().waitFor({ state: 'visible', timeout: 30000 });
  await emailInput.first().fill(email);

  const continueBtn = page
    .getByRole('button', { name: /continue|log in|sign in/i })
    .or(page.locator('button[type="submit"]'));

  await continueBtn.first().click();

  const passwordInput = page
    .getByLabel(/password/i)
    .or(page.locator('input[name="account[password]"]'))
    .or(page.locator('#account_password'));

  await passwordInput.first().waitFor({ state: 'visible', timeout: 30000 });
  await passwordInput.first().fill(password);

  await page
    .getByRole('button', { name: /log in|sign in|continue/i })
    .or(page.locator('button[type="submit"]'))
    .first()
    .click();

  await handleTwoFactor(page);

  await page.waitForURL(/admin\.shopify\.com|\.myshopify\.com\/admin/, {
    timeout: 120000,
  }).catch(async () => {
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  });

  const stillOnLogin = await page
    .locator('input[name="account[email]"], #account_email')
    .isVisible()
    .catch(() => false);

  if (stillOnLogin) {
    throw new Error(
      'Shopify login failed — still on login page. Check SHOPIFY_ADMIN_EMAIL, SHOPIFY_ADMIN_PASSWORD, and SHOPIFY_2FA_SECRET.'
    );
  }
}

export async function closeBrowser(browser) {
  if (browser) {
    await browser.close().catch(() => {});
  }
}
