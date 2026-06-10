/**
 * Export Shopify session cookies (Cookie-Editor JSON format) from your local browser.
 *
 * 1. Run: node scripts/export-shopify-cookies.js
 * 2. Pass Cloudflare + log into https://dailyshop-fuehd07p.myshopify.com/admin
 * 3. Press Enter in the terminal
 * 4. Upload: node scripts/upload-shopify-cookies.js
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { chromium } from 'patchright';
import { fileURLToPath } from 'url';
import { normalizeCookiesForPlaywright } from '../runner/browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(__dirname, '..', 'shopify-cookies.json');

const storeUrl =
  process.env.SHOPIFY_STORE_URL || 'https://dailyshop-fuehd07p.myshopify.com/admin';

console.log('\n=== Export Shopify cookies for QA Runner ===\n');
console.log(`Store: ${storeUrl}`);
console.log('1. Pass Cloudflare if shown');
console.log('2. Log in with "Remember me" checked');
console.log('3. Confirm you see the Shopify admin dashboard');
console.log('4. Return here and press Enter\n');

const browser = await chromium.launch({ headless: false, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise((resolve) =>
  rl.question('Press Enter when logged into Shopify admin... ', resolve)
);
rl.close();

const raw = await context.cookies();
const normalized = normalizeCookiesForPlaywright(
  raw.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expires: c.expires,
    session: !c.expires,
  }))
);

const exportFormat = normalized.map((c) => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  path: c.path,
  secure: c.secure,
  httpOnly: c.httpOnly,
  sameSite: c.sameSite === 'None' ? 'no_restriction' : c.sameSite?.toLowerCase() ?? 'lax',
  expirationDate: c.expires,
  session: !c.expires,
}));

fs.writeFileSync(outFile, JSON.stringify(exportFormat, null, 2));
console.log(`\nSaved ${exportFormat.length} cookies → ${outFile}`);

const hasCf = exportFormat.some((c) => c.name === 'cf_clearance');
const hasShopify = exportFormat.some((c) => /_shopify|shopify/i.test(c.name));
console.log(`  cf_clearance: ${hasCf ? 'yes' : 'no (Cloudflare may still challenge Railway)'}`);
console.log(`  shopify session cookies: ${hasShopify ? 'yes' : 'no — log in again'}`);
console.log('\nNext: node scripts/upload-shopify-cookies.js\n');

await browser.close();
