import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getPendingRun,
  updatePendingRun,
  storeSession,
  consumeSession,
} from './pending-runs.js';
import {
  startAuthBrowser,
  screenshotAuth,
  clickAuth,
  typeAuth,
  pressAuth,
  checkAuthComplete,
  exportAuthStorageState,
  stopAuthBrowser,
  solveAuthCloudflare,
} from './auth-browser.js';
import { runCycleOnAuthBrowser } from './run-cycle-auth.js';
import { savePersistedSession } from '../session/persistent-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function publicBaseUrl() {
  const base =
    process.env.PUBLIC_BASE_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : null) ||
    'http://localhost:3000';
  return base.replace(/\/$/, '');
}

function loadStoreUrl(appId) {
  const apps = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'config', 'apps.json'), 'utf8')
  );
  return apps[appId]?.store_url;
}

async function notifySlack(text, channel) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !channel) return;
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel, text }),
  });
}

export function registerAuthRoutes(app, { triggerWorkflow }) {
  app.get('/auth/:runId', (req, res) => {
    const run = getPendingRun(req.params.runId);
    if (!run) {
      res.status(404).send('This auth link expired or is invalid. Run /run-tests again in Slack.');
      return;
    }

    res.type('html').send(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Shopify login — QA Runner</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 960px; margin: 0 auto; padding: 16px; background: #111; color: #eee; }
    h1 { font-size: 1.25rem; }
  p.hint { color: #aaa; font-size: 0.9rem; }
    #screen { width: 100%; border: 1px solid #444; cursor: crosshair; display: block; background: #000; }
    #status { margin: 12px 0; padding: 8px; background: #222; border-radius: 6px; }
    input#typebox { width: 100%; padding: 8px; margin: 8px 0; font-size: 1rem; }
    button { padding: 8px 14px; margin: 4px 8px 4px 0; font-size: 0.95rem; cursor: pointer; }
    #cf-help { display: none; color: #fc6; font-size: 0.9rem; margin: 8px 0; }
    .ok { color: #6f6; }
  </style>
</head><body>
  <h1>Log in to Shopify — ${run.app} / ${run.cycleId}</h1>
  <p class="hint">Click the image to interact (email, password, Cloudflare checkbox). Type below and press Enter to send keys.</p>
  <div id="status">Starting browser…</div>
  <div id="cf-help">Cloudflare detected — click directly on the checkbox in the image. The page will not auto-reload while you verify.</div>
  <button type="button" id="cf-btn" style="display:none">Help click Cloudflare checkbox</button>
  <img id="screen" alt="Remote browser"/>
  <input id="typebox" placeholder="Type here, press Enter to send to browser" />
  <script>
    const runId = ${JSON.stringify(req.params.runId)};
    const img = document.getElementById('screen');
    const status = document.getElementById('status');
    const typebox = document.getElementById('typebox');
    const cfHelp = document.getElementById('cf-help');
    const cfBtn = document.getElementById('cf-btn');
    let pollTimer;
    let lastRefresh = 0;
    let onCloudflare = false;

    async function api(path, opts) {
      const r = await fetch('/auth/' + runId + path, opts);
      if (!r.ok) throw new Error(await r.text());
      return r;
    }

    async function refresh() {
      const r = await api('/screenshot');
      const blob = await r.blob();
      img.src = URL.createObjectURL(blob);
    }

  img.addEventListener('click', async (e) => {
      const rect = img.getBoundingClientRect();
      const x = Math.round((e.clientX - rect.left) * (1440 / rect.width));
      const y = Math.round((e.clientY - rect.top) * (900 / rect.height));
      status.textContent = 'Click at ' + x + ',' + y;
      await api('/click', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({x,y}) });
      await refresh();
    });

    typebox.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = typebox.value;
        typebox.value = '';
        await api('/type', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({text}) });
        await refresh();
      }
    });

    cfBtn.addEventListener('click', async () => {
      status.textContent = 'Clicking Cloudflare checkbox…';
      await api('/solve-cloudflare', { method: 'POST' });
      await refresh();
      status.textContent = 'If still stuck, click the checkbox in the image yourself.';
    });

    async function pollStatus() {
      const r = await api('/status');
      const data = await r.json();
      if (data.ready) {
        status.innerHTML = '<span class="ok">✓ Logged in! Starting tests…</span>';
        cfHelp.style.display = 'none';
        cfBtn.style.display = 'none';
        clearInterval(pollTimer);
        return;
      }
      onCloudflare = Boolean(data.cloudflare);
      cfHelp.style.display = onCloudflare ? 'block' : 'none';
      cfBtn.style.display = onCloudflare ? 'inline-block' : 'none';
      status.textContent = onCloudflare
        ? 'Cloudflare — click the checkbox in the image (no auto-reload)'
        : (data.title || data.url || 'Waiting for login…');

      const now = Date.now();
      const interval = onCloudflare ? 10000 : 3000;
      if (now - lastRefresh >= interval) {
        await refresh();
        lastRefresh = now;
      }
    }

    (async () => {
      await api('/start', { method: 'POST' });
      pollTimer = setInterval(pollStatus, 2000);
      await pollStatus();
    })().catch(err => { status.textContent = 'Error: ' + err.message; });
  </script>
</body></html>`);
  });

  app.post('/auth/:runId/start', async (req, res) => {
    try {
      const run = getPendingRun(req.params.runId);
      if (!run) return res.status(404).json({ error: 'Run not found' });
      const storeUrl = loadStoreUrl(run.app);
      if (!storeUrl) return res.status(400).json({ error: 'Unknown app store URL' });
      await startAuthBrowser(req.params.runId, storeUrl);
      res.json({ ok: true });
    } catch (err) {
      console.error('auth start:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/auth/:runId/screenshot', async (req, res) => {
    try {
      const png = await screenshotAuth(req.params.runId);
      res.type('png').send(png);
    } catch (err) {
      res.status(404).send(err.message);
    }
  });

  app.post('/auth/:runId/click', express.json(), async (req, res) => {
    try {
      await clickAuth(req.params.runId, req.body.x, req.body.y);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/auth/:runId/type', express.json(), async (req, res) => {
    try {
      await typeAuth(req.params.runId, req.body.text ?? '');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/auth/:runId/solve-cloudflare', async (req, res) => {
    try {
      const result = await solveAuthCloudflare(req.params.runId);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/auth/:runId/status', async (req, res) => {
    try {
      const run = getPendingRun(req.params.runId);
      if (!run) return res.status(404).json({ error: 'Run not found' });

      const check = await checkAuthComplete(req.params.runId);
      if (!check.ready) {
        return res.json(check);
      }

      if (run.status === 'running') {
        return res.json({ ready: true, alreadyStarted: true });
      }

      const storageStateBase64 = await exportAuthStorageState(req.params.runId);
      storeSession(req.params.runId, storageStateBase64);
      savePersistedSession(storageStateBase64);
      updatePendingRun(req.params.runId, { status: 'running' });

      await notifySlack(
        `✓ Shopify login saved for \`${run.app}\` cycle \`${run.cycleId}\`. Tests are running…\n` +
          `_You won't need to log in again until the session expires (usually weeks). Next time just run the same command._`,
        run.slackChannel
      );

      // Reuse the same browser — do not close it before tests (avoids Cloudflare re-challenge).
      runCycleOnAuthBrowser({
        runId: req.params.runId,
        app: run.app,
        cycleId: run.cycleId,
        slackChannel: run.slackChannel,
      }).catch((err) => console.error('Auth browser test run failed:', err));

      res.json({ ready: true, started: true });
    } catch (err) {
      console.error('auth status:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/session/:runId', (req, res) => {
    const secret = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!secret || secret !== process.env.AUTH_FETCH_SECRET) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const data = consumeSession(req.params.runId);
    if (!data) {
      res.status(404).json({ error: 'Session not found or already used' });
      return;
    }
    res.json({ storageState: data });
  });
}
