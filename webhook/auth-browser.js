import { chromium } from 'patchright';
import fs from 'fs';
import os from 'os';
import path from 'path';

const VIEWPORT = { width: 1440, height: 900 };
const sessions = new Map();

function storeHandleFromUrl(storeUrl) {
  const m = storeUrl.match(/admin\.shopify\.com\/store\/([^/?#]+)/i);
  if (m) return m[1];
  const m2 = storeUrl.match(/https?:\/\/([^.]+)\.myshopify\.com/i);
  return m2?.[1] ?? null;
}

async function isAdminReady(page) {
  const url = page.url();
  if (!/admin\.shopify\.com\/store\//i.test(url)) return false;
  const email = await page.locator('input[type="email"]').first().isVisible().catch(() => false);
  return !email;
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

  await page.goto('https://accounts.shopify.com/lookup', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });

  sessions.set(runId, { browser, context, page, storeUrl, target, viewport: VIEWPORT });

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
  await s.page.mouse.click(x, y);
  await s.page.waitForTimeout(500);
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

  // Nudge toward store admin if logged in at accounts
  const url = s.page.url();
  if (/admin\.shopify\.com/i.test(url) && !/store\//i.test(url)) {
    await s.page.goto(s.target, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }

  if (await isAdminReady(s.page)) {
    return { ready: true, url: s.page.url() };
  }

  return { ready: false, url: s.page.url(), title: await s.page.title().catch(() => '') };
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
