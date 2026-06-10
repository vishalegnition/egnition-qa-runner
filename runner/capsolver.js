/**
 * Optional CapSolver integration for Cloudflare Turnstile / challenge pages.
 * Set CAPSOLVER_API_KEY in GitHub secrets for fully automated CI login.
 * https://docs.capsolver.com/
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
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('CapSolver task timed out');
}

async function extractTurnstileSitekey(page) {
  for (const frame of page.frames()) {
    const src = frame.url();
    const m = src.match(/[?&]k=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
  }

  const fromDom = await page.evaluate(() => {
    const withKey = document.querySelector('[data-sitekey]');
    if (withKey) return withKey.getAttribute('data-sitekey');

    const iframe = document.querySelector(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]'
    );
    if (iframe?.src) {
      const m = iframe.src.match(/[?&]k=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    return null;
  });
  if (fromDom) return fromDom;

  const html = await page.content();
  for (const pattern of [
    /data-sitekey=["']([^"']+)["']/i,
    /sitekey["']?\s*[:=]\s*["']([^"']+)["']/i,
    /turnstile\.render\([^)]*sitekey\s*:\s*["']([^"']+)["']/i,
  ]) {
    const m = html.match(pattern);
    if (m) return m[1];
  }
  return null;
}

async function injectTurnstileToken(page, token) {
  await page.evaluate((t) => {
    const input =
      document.querySelector('input[name="cf-turnstile-response"]') ||
      document.querySelector('input[name="g-recaptcha-response"]');
    if (input) {
      input.value = t;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (typeof window.turnstileCallback === 'function') {
      window.turnstileCallback(t);
    }
  }, token);
}

/**
 * Attempt to solve Turnstile on the current page via CapSolver.
 */
export async function solveTurnstileOnPage(page) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) return false;

  await page.waitForTimeout(2000);
  const sitekey = await extractTurnstileSitekey(page);
  if (!sitekey) {
    console.warn('CapSolver: no Turnstile sitekey found on page — may be a full Cloudflare interstitial');
    return false;
  }

  console.log('CapSolver: solving Turnstile...');
  const { taskId } = await capsolverRequest('/createTask', {
    clientKey: apiKey,
    task: {
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL: page.url(),
      websiteKey: sitekey,
    },
  });

  const solution = await pollTask(taskId);
  const token = solution?.token;
  if (!token) return false;

  await injectTurnstileToken(page, token);
  await page.waitForTimeout(3000);
  return true;
}

/**
 * Attempt Cloudflare managed challenge solve (interstitial pages).
 */
export async function solveCloudflareChallenge(page) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) return false;

  const proxyConfig = getProxyConfig();
  if (!proxyConfig) {
    console.warn(
      'CapSolver: AntiCloudflareTask requires CAPSOLVER_PROXY (sticky residential proxy). Skipping challenge solve.'
    );
    return false;
  }

  const userAgent = await page.evaluate(() => navigator.userAgent);
  const pageUrl = page.url();

  console.log(`CapSolver: solving Cloudflare challenge via ${proxyConfig.playwright.server}...`);
  const task = {
    type: 'AntiCloudflareTask',
    websiteURL: pageUrl,
    userAgent,
    html: await page.content(),
    proxy: proxyConfig.capsolver,
  };

  const { taskId } = await capsolverRequest('/createTask', {
    clientKey: apiKey,
    task,
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

  const cookieDomain = cookieDomainForPage(pageUrl);

  if (entries.length > 0) {
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
    return !(await page.title().then((t) => /just a moment|verify you are human/i.test(t)));
  }

  if (solution?.token) {
    await injectTurnstileToken(page, solution.token);
    await page.waitForTimeout(3000);
    return true;
  }

  return false;
}
