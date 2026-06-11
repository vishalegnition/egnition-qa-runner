import { storeAdminUrl } from './browser.js';

const APP_NAME_ALIASES = {
  'BestSellers reSort': [/bestsellers?\s*resort/i, /bestsellers?/i, /\bresort\b/i, /egnition/i],
  StockIQ: [/stockiq/i, /stock\s*iq/i, /egnition/i],
  'Multi-Store Sync Power': [/multi-?store/i, /\bmssp\b/i, /egnition/i],
  'Commetiq Order Limits': [/commetiq/i, /order\s*limits/i, /egnition/i],
};

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

function storeHandleFromUrl(storeUrl) {
  const m = storeUrl.match(/https?:\/\/([^.]+)\.myshopify\.com/i);
  return m?.[1] ?? null;
}

function appPatterns(appConfig) {
  const patterns = [
    new RegExp(escapeRegExp(appConfig.name), 'i'),
    ...(APP_NAME_ALIASES[appConfig.name] ?? []),
  ];
  for (const term of appConfig.search_terms ?? []) {
    patterns.push(new RegExp(escapeRegExp(term), 'i'));
  }
  return patterns;
}

export function isInAppContext(page, appConfig) {
  const url = page.url();
  if (appPatterns(appConfig).some((p) => p.test(url))) return true;
  for (const f of page.frames()) {
    const frameUrl = f.url();
    if (/egnition|bestseller|resort|stockiq|commetiq|oosp|mssp/i.test(frameUrl)) {
      return true;
    }
  }
  return false;
}

/**
 * Find a clickable element across all frames (Shopify admin + embedded app iframes).
 */
export async function findClickable(page, target, appConfig) {
  let names = targetCandidates(target, appConfig);

  const wantsApp =
    appConfig &&
    appPatterns(appConfig).some((p) => p.test(String(target ?? ''))) &&
    !isInAppContext(page, appConfig);

  if (wantsApp) {
    names = ['Apps', ...names.filter((n) => n !== 'Apps')];
  }

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
          'nav a, [role="navigation"] a, [data-polaris-unstyled] a, .Polaris-Navigation__Item a, a[href*="/apps/"]'
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

async function clickAppLink(page, patterns) {
  for (const frame of page.frames()) {
    const links = await frame.locator('a[href*="/apps/"]').all();
    for (const link of links) {
      const text = ((await link.textContent()) ?? '').trim();
      const href = (await link.getAttribute('href')) ?? '';
      const haystack = `${text} ${href}`;
      if (!patterns.some((p) => p.test(haystack))) continue;
      if (!(await link.isVisible().catch(() => false))) continue;
      console.log(`Found app link: "${text}" → ${href}`);
      await link.click({ timeout: 20000 });
      return true;
    }
  }

  for (const pattern of patterns) {
    for (const frame of page.frames()) {
      for (const role of ['link', 'button', 'heading']) {
        const loc = frame.getByRole(role, { name: pattern }).first();
        if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
          await loc.click({ timeout: 20000 });
          return true;
        }
      }
      const card = frame.locator('a, [role="link"], button').filter({ hasText: pattern }).first();
      if ((await card.count()) > 0 && (await card.isVisible().catch(() => false))) {
        await card.click({ timeout: 20000 });
        return true;
      }
    }
  }
  return false;
}

async function searchAppsPage(page, query) {
  for (const frame of page.frames()) {
    const search = frame
      .getByPlaceholder(/search apps|search/i)
      .or(frame.getByRole('searchbox'))
      .first();
    if ((await search.count()) > 0 && (await search.isVisible().catch(() => false))) {
      await search.fill(query);
      await page.waitForTimeout(1500);
      return true;
    }
  }
  return false;
}

/**
 * Open the configured Shopify app from admin (Apps list → app link).
 */
export async function openApp(page, appConfig) {
  if (appConfig.app_url) {
    console.log(`Navigating to app URL: ${appConfig.app_url}`);
    await page.goto(appConfig.app_url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(3000);
    return;
  }

  const store = appConfig.store_url.replace(/\/$/, '');
  const handle = storeHandleFromUrl(store);
  const patterns = appPatterns(appConfig);
  const searchTerm = appConfig.search_terms?.[0] ?? 'BestSellers';

  console.log(`Opening app: ${appConfig.name}`);

  const appsUrls = [
    handle ? `https://admin.shopify.com/store/${handle}/apps` : null,
    `${store}/admin/apps`,
  ].filter(Boolean);

  for (const appsUrl of appsUrls) {
    await page.goto(appsUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(2500);
    await searchAppsPage(page, searchTerm);
    if (await clickAppLink(page, patterns)) {
      await page.waitForTimeout(4000);
      if (isInAppContext(page, appConfig)) return;
    }
  }

  await page.goto(storeAdminUrl(appConfig.store_url), {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await page.waitForTimeout(2000);

  const appsNav = await findClickable(page, 'Apps', appConfig);
  if (appsNav) {
    await appsNav.click({ timeout: 20000 });
    await page.waitForTimeout(2000);
    if (await clickAppLink(page, patterns)) {
      await page.waitForTimeout(4000);
      if (isInAppContext(page, appConfig)) return;
    }
  }

  const discovered = await discoverAppUrl(page, appConfig);
  if (discovered) {
    console.log(`Discovered app URL: ${discovered}`);
    await page.goto(discovered, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(4000);
    if (isInAppContext(page, appConfig)) return;
  }

  throw new Error(
    `Could not open "${appConfig.name}". Open it once in Shopify admin, copy the URL from the address bar, and add "app_url" to config/apps.json for this app.`
  );
}

async function discoverAppUrl(page, appConfig) {
  const patterns = appPatterns(appConfig);
  for (const frame of page.frames()) {
    for (const link of await frame.locator('a[href*="/apps/"]').all()) {
      const href = await link.getAttribute('href');
      const text = ((await link.textContent()) ?? '').trim();
      if (!href) continue;
      if (!patterns.some((p) => p.test(`${text} ${href}`))) continue;
      return href.startsWith('http') ? href : `https://admin.shopify.com${href}`;
    }
  }
  return null;
}

export async function ensureAppContext(page, appConfig) {
  if (isInAppContext(page, appConfig)) return;

  const adminUrl = storeAdminUrl(appConfig.store_url);
  if (!/\.myshopify\.com\/admin|admin\.shopify\.com/i.test(page.url())) {
    await page.goto(adminUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(2000);
  }

  await openApp(page, appConfig);
}
