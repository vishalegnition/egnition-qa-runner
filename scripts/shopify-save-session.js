/**
 * One-time manual Shopify login — saves session for CI.
 *
 * 1. Run: node scripts/shopify-save-session.js
 * 2. Log in in the browser window (including 2FA / Cloudflare if prompted)
 * 3. When you reach Shopify admin, press Enter in the terminal
 * 4. Copy the base64 string into GitHub secret: SHOPIFY_STORAGE_STATE
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(__dirname, '..', 'shopify-storage-state.json');

const storeUrl = process.env.SHOPIFY_STORE_URL || 'https://admin.shopify.com';

const browser = await chromium.launch({ headless: false, channel: 'chromium' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

console.log(`\nOpening ${storeUrl}`);
console.log('Log in manually, complete 2FA/Cloudflare, reach the admin, then return here.\n');

await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise((resolve) => rl.question('Press Enter after you are logged into Shopify admin... ', resolve));
rl.close();

await context.storageState({ path: outFile });
const b64 = Buffer.from(fs.readFileSync(outFile, 'utf8')).toString('base64');

console.log('\nSaved:', outFile);
console.log('\nAdd this to GitHub → Settings → Secrets → Actions as SHOPIFY_STORAGE_STATE:\n');
console.log(b64.slice(0, 80) + '...');
console.log(`\n(Full base64 length: ${b64.length} chars — copy entire string from ${outFile} or pipe:)`);
console.log(`  Get-Content shopify-storage-state.json -Raw | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_)) }`);

await browser.close();
