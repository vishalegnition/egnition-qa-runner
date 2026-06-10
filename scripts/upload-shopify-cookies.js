/**
 * Upload shopify-cookies.json to GitHub + Railway as SHOPIFY_SESSION_COOKIES.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cookieFile = path.join(__dirname, '..', 'shopify-cookies.json');
const repo = process.env.GITHUB_REPO || 'vishalegnition/egnition-qa-runner';
const railwayService =
  process.env.RAILWAY_SERVICE_ID || '33be08c9-9b86-400f-a949-1e8269531416';

if (!fs.existsSync(cookieFile)) {
  console.error('Missing shopify-cookies.json — run: node scripts/export-shopify-cookies.js');
  process.exit(1);
}

const json = fs.readFileSync(cookieFile, 'utf8').trim();
JSON.parse(json);

console.log(`Uploading ${json.length} chars to GitHub secret SHOPIFY_SESSION_COOKIES...`);
execSync(`gh secret set SHOPIFY_SESSION_COOKIES --repo ${repo}`, {
  input: json,
  stdio: ['pipe', 'inherit', 'inherit'],
});

if (process.env.RAILWAY_TOKEN) {
  console.log('Setting SHOPIFY_SESSION_COOKIES on Railway...');
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: {
      'Project-Access-Token': process.env.RAILWAY_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `mutation($input: VariableUpsertInput!) {
        variableUpsert(input: $input)
      }`,
      variables: {
        input: {
          projectId: process.env.RAILWAY_PROJECT_ID || 'c5492fb7-2fab-48ff-9d82-e39c86de22a6',
          environmentId: process.env.RAILWAY_ENVIRONMENT_ID || '8efb00a3-21b9-4d20-8b2d-e689417f37dd',
          serviceId: railwayService,
          name: 'SHOPIFY_SESSION_COOKIES',
          value: json,
        },
      },
    }),
  });
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join('; '));
  }
  console.log('Railway variable updated — redeploy to apply: railway redeploy -y');
} else {
  console.log('Set RAILWAY_TOKEN to also update Railway variables automatically.');
  console.log('Or paste shopify-cookies.json into Railway → qa-automation → Variables.');
}

console.log('Done. Re-run /run-tests in Slack.');
