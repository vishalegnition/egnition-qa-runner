import { chromium } from 'playwright';

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

  // Shopify login — email field
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

  // Password step (may appear on same or next page)
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

  // Wait for admin shell (navigation or dashboard)
  await page.waitForURL(/admin\.shopify\.com|\.myshopify\.com\/admin/, {
    timeout: 120000,
  }).catch(async () => {
    // Some stores stay on custom domain admin
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  });

  const stillOnLogin = await page
    .locator('input[name="account[email]"], #account_email')
    .isVisible()
    .catch(() => false);

  if (stillOnLogin) {
    throw new Error('Shopify login failed — still on login page. Check credentials.');
  }
}

export async function closeBrowser(browser) {
  if (browser) {
    await browser.close().catch(() => {});
  }
}
