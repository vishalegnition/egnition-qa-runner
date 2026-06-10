import { storeAdminUrl } from './browser.js';

/** Candidate link names to try (shortest first). */
export function targetCandidates(target, appConfig) {
  const t = String(target ?? '').trim();
  const candidates = new Set();

  for (const m of t.matchAll(/"([^"]+)"/g)) candidates.add(m[1]);

  const rules = [
    [/\bbestsellers?\s*resort/i, 'BestSellers reSort'],
    [/\bstockiq/i, 'StockIQ'],
    [/\bmulti-?store\s*sync/i, 'Multi-Store Sync Power'],
    [/\bcommetiq\s*order\s*limits/i, 'Commetiq Order Limits'],
    [/\bapps?\b/i, 'Apps'],
    [/\bproducts?\b/i, 'Products'],
    [/\bcollections?\b/i, 'Collections'],
    [/\borders?\b/i, 'Orders'],
    [/\bcustomers?\b/i, 'Customers'],
    [/\bsettings?\b/i, 'Settings'],
    [/\bhome\b/i, 'Home'],
    [/\bsave\b/i, 'Save'],
    [/\bsearch\b/i, 'Search'],
  ];

  for (const [re, label] of rules) {
    if (re.test(t)) candidates.add(label);
  }

  const stripped = t
    .replace(/\s+(menu|link|navigation|nav|item|sidebar|button|textbox|field).*$/i, '')
    .replace(/^(click|open|select|press|tap)\s+(the\s+)?/i, '')
    .trim();
  if (stripped.length >= 2 && stripped.length <= 60) candidates.add(stripped);

  if (appConfig?.name && t.toLowerCase().includes('app')) {
    candidates.add(appConfig.name);
  }

  candidates.add(t);

  return [...candidates]
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .sort((a, b) => a.length - b.length);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find a clickable element across all frames (Shopify admin + embedded app iframes).
 */
export async function findClickable(page, target, appConfig) {
  const names = targetCandidates(target, appConfig);

  for (const name of names) {
    const pattern = new RegExp(escapeRegExp(name), 'i');

    for (const frame of page.frames()) {
      for (const role of ['link', 'button', 'menuitem', 'tab', 'option']) {
        const loc = frame.getByRole(role, { name: pattern }).first();
        if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
          return loc;
        }
      }

      const polaris = frame
        .locator(
          'nav a, [role="navigation"] a, [data-polaris-unstyled] a, .Polaris-Navigation__Item a'
        )
        .filter({ hasText: pattern })
        .first();
      if ((await polaris.count()) > 0 && (await polaris.isVisible().catch(() => false))) {
        return polaris;
      }

      const byText = frame.getByText(pattern).first();
      if ((await byText.count()) > 0 && (await byText.isVisible().catch(() => false))) {
        return byText;
      }
    }
  }

  return null;
}

export async function findFillable(page, target, appConfig) {
  const names = targetCandidates(target, appConfig);

  for (const name of names) {
    const pattern = new RegExp(escapeRegExp(name), 'i');
    for (const frame of page.frames()) {
      for (const role of ['textbox', 'combobox', 'searchbox', 'spinbutton']) {
        const loc = frame.getByRole(role, { name: pattern }).first();
        if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
          return loc;
        }
      }
      const byLabel = frame.getByLabel(pattern).first();
      if ((await byLabel.count()) > 0 && (await byLabel.isVisible().catch(() => false))) {
        return byLabel;
      }
      const byPlaceholder = frame.getByPlaceholder(pattern).first();
      if ((await byPlaceholder.count()) > 0 && (await byPlaceholder.isVisible().catch(() => false))) {
        return byPlaceholder;
      }
    }
  }

  return null;
}

/**
 * Open the configured Shopify app from admin (Apps list → app link).
 */
export async function openApp(page, appConfig) {
  const store = appConfig.store_url.replace(/\/$/, '');
  const appsUrl = `${store}/admin/apps`;
  const appPattern = new RegExp(escapeRegExp(appConfig.name), 'i');

  console.log(`Navigating to app: ${appConfig.name}`);
  await page.goto(appsUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(2500);

  for (const frame of page.frames()) {
    const link = frame.getByRole('link', { name: appPattern }).first();
    if ((await link.count()) > 0 && (await link.isVisible().catch(() => false))) {
      await link.click({ timeout: 20000 });
      await page.waitForTimeout(4000);
      return;
    }
  }

  if (appConfig.app_url) {
    await page.goto(appConfig.app_url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(3000);
    return;
  }

  throw new Error(
    `Could not open app "${appConfig.name}" from ${appsUrl}. Add app_url to config/apps.json if needed.`
  );
}

export async function ensureAppContext(page, appConfig) {
  const adminUrl = storeAdminUrl(appConfig.store_url);
  const url = page.url();

  if (!/\.myshopify\.com\/admin|admin\.shopify\.com/i.test(url)) {
    await page.goto(adminUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(2000);
  }

  let inApp = new RegExp(escapeRegExp(appConfig.name), 'i').test(url);
  if (!inApp) {
    for (const f of page.frames()) {
      if (/app|egnition|bestseller|resort|stockiq|commetiq/i.test(f.url())) {
        inApp = true;
        break;
      }
    }
  }

  if (!inApp) {
    await openApp(page, appConfig);
  }
}
