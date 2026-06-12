import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadHistory } from './history.js';
import { loadAppConfig, runLocalCycle } from './runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const PORT = Number(process.env.LOCAL_PORT || process.env.PORT || 3000);

const app = express();
app.use(express.json());

/** @type {string | null} */
let activeRunId = null;

/** @type {Map<string, Set<(event: object) => void>>} */
const streamListeners = new Map();

function broadcast(runId, event) {
  const listeners = streamListeners.get(runId);
  if (!listeners) return;
  for (const fn of listeners) fn(event);
}

function appsList() {
  const appsPath = path.join(repoRoot, 'config', 'apps.json');
  const apps = JSON.parse(fs.readFileSync(appsPath, 'utf8'));
  return Object.entries(apps).map(([id, cfg]) => ({
    id,
    name: cfg.name,
  }));
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(repoRoot, 'frontend', 'index.html'));
});

app.get('/apps', (_req, res) => {
  res.json(appsList());
});

app.get('/history', (_req, res) => {
  res.json(loadHistory());
});

app.post('/run', (req, res) => {
  const appId = String(req.body?.app ?? '').trim();
  const cycleId = String(req.body?.cycleId ?? '').trim();

  if (!appId || !cycleId) {
    res.status(400).json({ error: 'app and cycleId are required' });
    return;
  }

  try {
    loadAppConfig(appId);
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }

  if (activeRunId) {
    res.status(409).json({ error: 'A run is already in progress' });
    return;
  }

  const runId = crypto.randomUUID();
  activeRunId = runId;
  streamListeners.set(runId, new Set());

  res.json({ runId });

  const emit = (event) => broadcast(runId, event);

  runLocalCycle({ appId, cycleId, runId, emit })
    .catch((err) => console.error('Run failed:', err))
    .finally(() => {
      activeRunId = null;
      setTimeout(() => streamListeners.delete(runId), 60_000);
    });
});

app.get('/stream/:runId', (req, res) => {
  const { runId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'complete' || event.type === 'error') {
      res.end();
    }
  };

  if (!streamListeners.has(runId)) {
    streamListeners.set(runId, new Set());
  }
  streamListeners.get(runId).add(send);

  req.on('close', () => {
    streamListeners.get(runId)?.delete(send);
  });
});

app.listen(PORT, () => {
  console.log(`Egnition QA Runner — local web UI at http://localhost:${PORT}`);
  console.log('Connect QA Chrome on port', process.env.CHROME_DEBUG_PORT || 9222);
});
