/**
 * CapSolver integration for Cloudflare Turnstile on Shopify admin.
 * AntiTurnstileTaskProxyLess solves the widget token — inject it into the
 * BrowserStack page (same IP, unlike cf_clearance cookies from a proxy).
 */

import { getProxyConfig } from './proxy.js';

const API = 'https://api.capsolver.com';

function cookieDomainForPage(pageUrl) {
  try {
    const host = new URL(pageUrl).hostname;
    if (host.endsWith('.myshopify.com')) return host;
    if (host.includes('shopify.com')) return '.shopify.com';
    return host;
  } catch {
    return '.shopify.com';
  }
}

async function capsolverRequest(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.errorId) {
    throw new Error(`CapSolver: ${data.errorDescription || data.errorCode}`);
  }
  return data;
}

async function pollTask(taskId, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const result = await capsolverRequest('/getTaskResult', {
      clientKey: process.env.CAPSOLVER_API_KEY,
      taskId,
    });
    if (result.status === 'ready') return result.solution;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error('CapSolver task timed out');
}

async function extractTurnstileSitekey(page) {
  for (const frame of page.frames()) {
    const src = frame.url();
    const m = src.match(/[?&/]k=([^&/]+)/);
    if (m) return decodeURIComponent(m[1]);
  }

  const fromDom = await page.evaluate(() => {
    const withKey = document.querySelector('[data-sitekey]');
    if (withKey) return withKey.getAttribute('data-sitekey');

    for (const iframe of document.querySelectorAll('iframe')) {
      const src = iframe.src || '';
      const m = src.match(/[?&/]k=([^&/]+)/);
      if (m) return decodeURIComponent(m[1]);
    }

    const scripts = Array.from(document.scripts).map((s) => s.textContent || '').join('\n');
    const scriptKey = scripts.match(/sitekey\s*[:=]\s*["']([^"']+)["']/i);
    if (scriptKey) return scriptKey[1];

    return null;
  });
  if (fromDom) return fromDom;

  const html = await page.content();
  for (const pattern of [
    /data-sitekey=["']([^"']+)["']/i,
    /sitekey["']?\s*[:=]\s*["']([^"']+)["']/i,
    /turnstile\.render\([^)]*sitekey\s*:\s*["']([^"']+)["']/i,
    /(0x4[A-Za-z0-9_-]{10,})/,
  ]) {
    const m = html.match(pattern);
    if (m) return m[1];
  }
  return null;
}

/** Click the Turnstile checkbox inside Cloudflare iframes. */
export async function clickTurnstileWidget(page) {
  for (const frame of page.frames()) {
    if (!/challenges\.cloudflare\.com|turnstile/i.test(frame.url())) continue;
    for (const sel of [
      'input[type="checkbox"]',
      '.ctp-checkbox-label',
      'label',
      '#challenge-stage',
      'body',
    ]) {
      const loc = frame.locator(sel).first();
      if ((await loc.count()) > 0) {
        await loc.click({ timeout: 5000, force: true }).catch(() => {});
        console.log('Clicked Turnstile widget in iframe');
        return true;
      }
    }
  }

  const iframe = page.locator('iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]').first();
  if ((await iframe.count()) > 0) {
    const box = await iframe.boundingBox();
    if (box) {
      await page.mouse.click(box.x + 28, box.y + box.height / 2);
      console.log('Clicked Turnstile iframe by coordinates');
      return true;
    }
  }

  const label = page.getByText(/verify you are human/i).first();
  if (await label.isVisible().catch(() => false)) {
    await label.click({ timeout: 5000 }).catch(() => {});
    return true;
  }

  return false;
}

async function injectTurnstileToken(page, token) {
  await page.evaluate((t) => {
    for (const input of document.querySelectorAll(
      'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
    )) {
      input.value = t;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (typeof window.turnstileCallback === 'function') {
      window.turnstileCallback(t);
    }

    const turnstile = window.turnstile;
    if (turnstile && typeof turnstile.getResponse === 'function') {
      try {
        const widgets = document.querySelectorAll('.cf-turnstile, [data-sitekey]');
        widgets.forEach((el, i) => {
          if (typeof turnstile.execute === 'function') turnstile.execute(el);
        });
      } catch {
        /* ignore */
      }
    }
  }, token);
}

async function submitCloudflareChallengeForm(page) {
  const submitted = await page.evaluate(() => {
    const form =
      document.querySelector('#challenge-form') ||
      document.querySelector('form[action*="cdn-cgi"]') ||
      document.querySelector('form');
    if (form) {
      form.submit();
      return true;
    }
    const btn = document.querySelector('button[type="submit"], input[type="submit"]');
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (submitted) {
    console.log('Submitted Cloudflare challenge form');
    return;
  }

  await page.keyboard.press('Enter').catch(() => {});
}

async function waitUntilCloudflareClears(page, maxMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const title = await page.title().catch(() => '');
    const url = page.url();
    if (!/just a moment|verify you are human|needs to be verified/i.test(title)) {
      if (!url.includes('__cf_chl') && !url.includes('challenges.cloudflare.com')) {
        return true;
      }
    }
    const stillVisible = await page
      .getByText(/verify you are human|your connection needs to be verified/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (!stillVisible) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

/**
 * Attempt to solve Turnstile on the current page via CapSolver (proxy-less).
 */
export async function solveTurnstileOnPage(page) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) return false;

  await page.waitForTimeout(1500);
  const sitekey = await extractTurnstileSitekey(page);
  if (!sitekey) {
    console.warn('CapSolver: no Turnstile sitekey found on page');
    return false;
  }

  const pageUrl = page.url();
  console.log(`CapSolver: solving Turnstile (sitekey=${sitekey.slice(0, 12)}…) for ${pageUrl}`);

  const { taskId } = await capsolverRequest('/createTask', {
    clientKey: apiKey,
    task: {
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL: pageUrl,
      websiteKey: sitekey,
    },
  });

  const solution = await pollTask(taskId);
  const token = solution?.token;
  if (!token) return false;

  console.log('CapSolver: injecting Turnstile token…');
  await injectTurnstileToken(page, token);
  await page.waitForTimeout(1000);
  await submitCloudflareChallengeForm(page);
  await page.waitForTimeout(2000);

  return waitUntilCloudflareClears(page, 30000);
}

/**
 * Full Cloudflare interstitial via proxy (only works when browser uses same proxy IP).
 * Skipped on BrowserStack — cookies are IP-bound.
 */
export async function solveCloudflareChallenge(page) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) return false;

  const proxyConfig = getProxyConfig();
  if (!proxyConfig) {
    console.warn('CapSolver: AntiCloudflareTask requires CAPSOLVER_PROXY');
    return false;
  }

  const userAgent = await page.evaluate(() => navigator.userAgent);
  const pageUrl = page.url();

  console.log(`CapSolver: solving Cloudflare challenge via ${proxyConfig.playwright.server}...`);
  const { taskId } = await capsolverRequest('/createTask', {
    clientKey: apiKey,
    task: {
      type: 'AntiCloudflareTask',
      websiteURL: pageUrl,
      userAgent,
      html: await page.content(),
      proxy: proxyConfig.capsolver,
    },
  });

  const solution = await pollTask(taskId, 180000);

  const cookieMap =
    solution?.cookies && typeof solution.cookies === 'object' ? solution.cookies : {};
  const entries = Array.isArray(solution?.cookies)
    ? solution.cookies
    : Object.entries(cookieMap).map(([name, value]) => ({ name, value }));

  if (solution?.cf_clearance) {
    entries.push({ name: 'cf_clearance', value: solution.cf_clearance });
  }

  if (entries.length > 0) {
    const cookieDomain = cookieDomainForPage(pageUrl);
    await page.context().addCookies(
      entries.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || cookieDomain,
        path: c.path || '/',
        sameSite: 'Lax',
        secure: true,
      }))
    );
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(3000);
    return waitUntilCloudflareClears(page, 20000);
  }

  if (solution?.token) {
    await injectTurnstileToken(page, solution.token);
    await submitCloudflareChallengeForm(page);
    return waitUntilCloudflareClears(page, 20000);
  }

  return false;
}

/**
 * Main bypass: click widget → CapSolver Turnstile → wait. No pointless 60s idle wait.
 */
export async function bypassCloudflareOnPage(page, { useProxyChallenge = false } = {}) {
  const hasCapsolver = Boolean(process.env.CAPSOLVER_API_KEY?.trim());

  for (let attempt = 0; attempt < 4; attempt++) {
    if (await waitUntilCloudflareClears(page, 3000)) return true;

    console.log(`Cloudflare bypass attempt ${attempt + 1}/4…`);
    await clickTurnstileWidget(page).catch(() => {});
    await page.waitForTimeout(2000);

    if (hasCapsolver) {
      try {
        if (await solveTurnstileOnPage(page)) return true;
      } catch (err) {
        console.warn('CapSolver Turnstile:', err.message);
      }

      if (useProxyChallenge) {
        try {
          if (await solveCloudflareChallenge(page)) return true;
        } catch (err) {
          console.warn('CapSolver Challenge:', err.message);
        }
      }
    }

    await clickTurnstileWidget(page).catch(() => {});
    if (await waitUntilCloudflareClears(page, 12000)) return true;
  }

  return false;
}
