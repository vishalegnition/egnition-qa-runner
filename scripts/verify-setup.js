/**
 * Local smoke checks — no external API keys required.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseModelResponse, pickBestGeminiVisionModel } from '../runner/vision.js';
import { buildReport } from '../runner/slack.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let failed = 0;

function ok(label) {
  console.log(`  OK  ${label}`);
}

function fail(label, err) {
  console.error(`  FAIL ${label}: ${err?.message ?? err}`);
  failed++;
}

// apps.json
try {
  const apps = JSON.parse(
    fs.readFileSync(path.join(root, 'config', 'apps.json'), 'utf8')
  );
  const required = ['br', 'oosp', 'mssp', 'ol'];
  for (const id of required) {
    if (!apps[id]?.store_url || !apps[id]?.name) {
      throw new Error(`missing config for ${id}`);
    }
  }
  ok('config/apps.json');
} catch (e) {
  fail('config/apps.json', e);
}

// vision JSON parser
try {
  const parsed = parseModelResponse(
    '```json\n{"action":"click","target":"Save"}\n```'
  );
  if (parsed.action !== 'click') throw new Error('unexpected parse');
  ok('vision.parseModelResponse');
} catch (e) {
  fail('vision.parseModelResponse', e);
}

// Gemini model auto-select ranking
try {
  const best = pickBestGeminiVisionModel([
    {
      id: 'google/gemini-flash-1.5',
      created: 1,
      architecture: { input_modalities: ['text', 'image'] },
    },
    {
      id: 'google/gemini-2.0-flash-exp',
      created: 2,
      architecture: { input_modalities: ['text', 'image'] },
    },
    {
      id: 'google/gemini-2.5-pro-preview',
      created: 3,
      architecture: { input_modalities: ['text', 'image'] },
    },
  ]);
  if (best !== 'google/gemini-2.0-flash-exp') {
    throw new Error(`expected gemini-2.0-flash-exp, got ${best}`);
  }
  ok('vision.pickBestGeminiVisionModel');
} catch (e) {
  fail('vision.pickBestGeminiVisionModel', e);
}

// slack report builder
try {
  const text = buildReport({
    appName: 'BestSellers reSort',
    cycleId: 'CYCLE-42',
    startedAt: new Date('2026-06-04T14:03:00Z'),
    durationMs: 502000,
    results: [
      { key: 'TC-001', name: 'Test one', passed: true },
      { key: 'TC-007', name: 'Test fail', passed: false, reason: 'Toggle not found' },
    ],
  });
  if (!text.includes('50%') || !text.includes('TC-007')) {
    throw new Error('report format unexpected');
  }
  ok('slack.buildReport');
} catch (e) {
  fail('slack.buildReport', e);
}

// workflow file exists
try {
  const wf = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'run-tests.yml'),
    'utf8'
  );
  if (!wf.includes('workflow_dispatch')) throw new Error('missing dispatch');
  ok('.github/workflows/run-tests.yml');
} catch (e) {
  fail('workflow', e);
}

// .env.example keys
try {
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const keys = [
    'SLACK_SIGNING_SECRET',
    'GITHUB_TOKEN',
    'ZEPHYR_API_TOKEN',
    'OPENROUTER_API_KEY',
    'SLACK_BOT_TOKEN',
  ];
  for (const k of keys) {
    if (!example.includes(k)) throw new Error(`missing ${k} in .env.example`);
  }
  ok('.env.example');
} catch (e) {
  fail('.env.example', e);
}

console.log('');
if (failed) {
  console.error(`${failed} check(s) failed.`);
  process.exit(1);
}
console.log('All local setup checks passed.');
