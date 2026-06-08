/**
 * Optional CapSolver integration for Cloudflare Turnstile / challenge pages.
 * Set CAPSOLVER_API_KEY in GitHub secrets for fully automated CI login.
 * https://docs.capsolver.com/
 */

const API = 'https://api.capsolver.com';

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
  return page.evaluate(() => {
    const withKey = document.querySelector('[data-sitekey]');
    if (withKey) return withKey.getAttribute('data-sitekey');

    const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]');
    if (iframe?.src) {
      const m = iframe.src.match(/[?&]k=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    return null;
  });
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

  const sitekey = await extractTurnstileSitekey(page);
  if (!sitekey) return false;

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

  console.log('CapSolver: solving Cloudflare challenge...');
  const task = {
    type: 'AntiCloudflareTask',
    websiteURL: page.url(),
    userAgent: await page.evaluate(() => navigator.userAgent),
  };

  const proxy = process.env.CAPSOLVER_PROXY;
  if (proxy) {
    task.proxy = proxy;
  }

  const { taskId } = await capsolverRequest('/createTask', {
    clientKey: apiKey,
    task,
  });

  const solution = await pollTask(taskId, 180000);
  if (!solution?.cookies) return false;

  const cookies = Array.isArray(solution.cookies) ? solution.cookies : [];
  if (solution.cf_clearance) {
    cookies.push({
      name: 'cf_clearance',
      value: solution.cf_clearance,
      domain: '.shopify.com',
      path: '/',
    });
  }

  if (cookies.length > 0) {
    await page.context().addCookies(
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.shopify.com',
        path: c.path || '/',
      }))
    );
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(3000);
    return true;
  }

  if (solution.token) {
    await injectTurnstileToken(page, solution.token);
    await page.waitForTimeout(3000);
    return true;
  }

  return false;
}
