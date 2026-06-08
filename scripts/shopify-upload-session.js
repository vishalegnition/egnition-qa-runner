/**
 * Upload shopify-storage-state.json to GitHub Actions secret SHOPIFY_STORAGE_STATE
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(__dirname, '..', 'shopify-storage-state.json');
const repo = process.env.GITHUB_REPO || 'vishalegnition/egnition-qa-runner';

if (!fs.existsSync(stateFile)) {
  console.error('Missing shopify-storage-state.json — run: node scripts/shopify-save-session.js');
  process.exit(1);
}

const b64 = Buffer.from(fs.readFileSync(stateFile, 'utf8')).toString('base64');
console.log(`Uploading session (${b64.length} chars) to ${repo}...`);

execSync(`gh secret set SHOPIFY_STORAGE_STATE --repo ${repo}`, {
  input: b64,
  stdio: ['pipe', 'inherit', 'inherit'],
});

console.log('Done. SHOPIFY_STORAGE_STATE is set. Re-run /run-tests in Slack.');
