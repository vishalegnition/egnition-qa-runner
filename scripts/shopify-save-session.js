/**
 * One-time manual Shopify login — saves session for CI.
 *
 * Run: node scripts/shopify-save-session.js
 * Then upload to GitHub: node scripts/shopify-upload-session.js
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(__dirname, '..', 'shopify-storage-state.json');

const storeUrl =
  process.env.SHOPIFY_STORE_URL || 'https://admin.shopify.com';

console.log('\n=== Shopify session saver (for CI) ===\n');
console.log('GitHub Actions cannot click Cloudflare for you.');
console.log('YOU solve Cloudflare + login here once; CI reuses this session for weeks.\n');

const browser = await chromium.launch({ headless: false, channel: 'chromium' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

console.log(`Opening ${storeUrl}`);
console.log('1. Log in (email, password, 2FA, Cloudflare if shown)');
console.log('2. Open your dev store admin');
console.log('3. Return here and press Enter\n');

await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise((resolve) =>
  rl.question('Press Enter when logged into Shopify admin... ', resolve)
);
rl.close();

await context.storageState({ path: outFile });
console.log(`\nSaved: ${outFile}`);
console.log('\nNext step — upload to GitHub:');
console.log('  node scripts/shopify-upload-session.js\n');

await browser.close();
