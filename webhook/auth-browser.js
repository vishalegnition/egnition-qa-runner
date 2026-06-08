import { chromium } from 'patchright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { solveTurnstileOnPage, solveCloudflareChallenge } from '../runner/capsolver.js';

const VIEWPORT = { width: 1440, height: 900 };
const sessions = new Map();

function storeHandleFromUrl(storeUrl) {
  const m = storeUrl.match(/admin\.shopify\.com\/store\/([^/?#]+)/i);
  if (m) return m[1];
  const m2 = storeUrl.match(/https?:\/\/([^.]+)\.myshopify\.com/i);
  return m2?.[1] ?? null;
}

function emailInput(page) {
  return page
    .locator('input[type="email"]')
    .or(page.getByLabel(/email/i))
    .or(page.locator('input[name="account[email]"]'))
    .or(page.locator('#account_email'));
}

export async function isCloudflarePage(page) {
  const title = await page.title().catch(() => '');
  const url = page.url();
  if (/just a moment|verifying your connection|attention required|needs to be verified/i.test(title)) {
    return true;
  }
  if (url.includes('__cf_chl') || url.includes('challenges.cloudflare.com')) {
    return true;
  }
  const hasTurnstile = (await page.locator('input[name="cf-turnstile-response"]').count()) > 0;
  const hasEmail = (await emailInput(page).count()) > 0;
  return hasTurnstile && !hasEmail;
}

async function isAdminReady(page) {
  const url = page.url();
  if (!/admin\.shopify\.com\/store\//i.test(url) && !/\.myshopify\.com\/admin/i.test(url)) {
    return false;
  }
  return !(await emailInput(page).first().isVisible().catch(() => false));
}

async function clickTurnstileCenter(page) {
  const iframe = page
    .locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]')
    .first();
  if ((await iframe.count()) === 0) return false;
  const box = await iframe.boundingBox();
  if (!box) return false;
  await page.mouse.click(box.x + 32, box.y + box.height / 2);
  await page.waitForTimeout(800);
  return true;
}

export async function startAuthBrowser(runId, storeUrl) {
  if (sessions.has(runId)) {
    await stopAuthBrowser(runId).catch(() => {});
  }

  const handle = storeHandleFromUrl(storeUrl);
  const target = handle
    ? `https://admin.shopify.com/store/${handle}`
    : `${storeUrl.replace(/\/$/, '')}/admin`;

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();

  await page.goto(target, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });

  sessions.set(runId, {
    browser,
    context,
    page,
    storeUrl,
    target,
    viewport: VIEWPORT,
    nudgeAttempted: false,
  });

  return { runId, url: page.url() };
}

export function getAuthSession(runId) {
  return sessions.get(runId);
}

export async function screenshotAuth(runId) {
  const s = sessions.get(runId);
  if (!s) throw new Error('Auth session not started');
  return s.page.screenshot({ type: 'png' });
}

export async function clickAuth(runId, x, y) {
  const s = sessions.get(runId);
  if (!s) throw new Error('Auth session not started');
  const page = s.page;

  let hitIframe = false;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const handle = await frame.frameElement();
      if (!handle) continue;
      const box = await handle.boundingBox();
      if (!box) continue;
      if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) {
        hitIframe = true;
        break;
      }
    } catch {
      /* cross-origin frame */
    }
  }

  await page.mouse.click(x, y);
  if (hitIframe || (await isCloudflarePage(page))) {
    await page.waitForTimeout(400);
    await clickTurnstileCenter(page).catch(() => {});
  }
  await page.waitForTimeout(800);
}

export async function solveAuthCloudflare(runId) {
  const s = sessions.get(runId);
  if (!s) throw new Error('Auth session not started');
  const page = s.page;

  if (process.env.CAPSOLVER_API_KEY) {
    const solved =
      (await solveTurnstileOnPage(page).catch(() => false)) ||
      (await solveCloudflareChallenge(page).catch(() => false));
    if (solved) return { method: 'capsolver' };
  }

  const clicked = await clickTurnstileCenter(page);
  return { method: clicked ? 'click' : 'none' };
}

export async function typeAuth(runId, text) {
  const s = sessions.get(runId);
  if (!s) throw new Error('Auth session not started');
  await s.page.keyboard.type(text);
}

export async function pressAuth(runId, key) {
  const s = sessions.get(runId);
  if (!s) throw new Error('Auth session not started');
  await s.page.keyboard.press(key);
}

export async function checkAuthComplete(runId) {
  const s = sessions.get(runId);
  if (!s) return { ready: false };

  if (await isAdminReady(s.page)) {
    return { ready: true, url: s.page.url() };
  }

  const cloudflare = await isCloudflarePage(s.page);
  const url = s.page.url();

  // Nudge once toward store admin after login — never while Cloudflare is active (reload loop)
  if (
    !cloudflare &&
    !s.nudgeAttempted &&
    /accounts\.shopify\.com|admin\.shopify\.com/i.test(url) &&
    !/admin\.shopify\.com\/store\//i.test(url)
  ) {
    s.nudgeAttempted = true;
    await s.page.goto(s.target, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }

  if (await isAdminReady(s.page)) {
    return { ready: true, url: s.page.url() };
  }

  return {
    ready: false,
    url,
    cloudflare,
    title: await s.page.title().catch(() => ''),
  };
}

export async function exportAuthStorageState(runId) {
  const s = sessions.get(runId);
  if (!s) throw new Error('Auth session not started');

  if (!(await isAdminReady(s.page))) {
    await s.page.goto(s.target, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }

  const tmp = path.join(os.tmpdir(), `shopify-auth-${runId}.json`);
  await s.context.storageState({ path: tmp });
  const json = fs.readFileSync(tmp, 'utf8');
  fs.unlinkSync(tmp);
  return Buffer.from(json).toString('base64');
}

export async function stopAuthBrowser(runId) {
  const s = sessions.get(runId);
  if (!s) return;
  await s.browser.close().catch(() => {});
  sessions.delete(runId);
}
