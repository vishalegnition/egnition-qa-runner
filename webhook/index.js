import crypto from 'crypto';
import express from 'express';

const VALID_APPS = ['br', 'oosp', 'mssp', 'ol'];

function verifySlackSignature(signingSecret, signature, timestamp, rawBody) {
  if (!signature || !timestamp) return false;

  const fiveMinutes = 60 * 5;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > fiveMinutes) {
    return false;
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto
    .createHmac('sha256', signingSecret)
    .update(base, 'utf8')
    .digest('hex');
  const expected = `v0=${hmac}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(signature, 'utf8')
    );
  } catch {
    return false;
  }
}

function parseCommand(text) {
  const parts = (text ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return {
      ok: false,
      error:
        'Usage: `/run-tests [app] [cycle-id]`\n\nExample: `/run-tests br BR-R104`\n\nValid apps: ' +
        VALID_APPS.join(', '),
    };
  }

  const app = parts[0].toLowerCase();
  const cycleId = parts[1];

  if (!VALID_APPS.includes(app)) {
    return {
      ok: false,
      error: `Unknown app "${parts[0]}". Valid apps: ${VALID_APPS.join(', ')}`,
    };
  }

  return { ok: true, app, cycleId };
}

async function triggerGitHubWorkflow({ app, cycleId }) {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_REPO_OWNER;
  const repo = process.env.GITHUB_REPO_NAME;

  if (!token || !owner || !repo) {
    throw new Error('GITHUB_TOKEN, GITHUB_REPO_OWNER, and GITHUB_REPO_NAME are required');
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/run-tests.yml/dispatches`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: { app, cycle_id: cycleId },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub dispatch failed ${res.status}: ${body.slice(0, 500)}`);
  }
}

const app = express();
const rawBodyParser = express.raw({ type: 'application/x-www-form-urlencoded' });

app.post('/trigger', rawBodyParser, async (req, res) => {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    res.status(500).send('Server misconfigured');
    return;
  }

  const rawBody = req.body.toString('utf8');
  const signature = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];

  if (!verifySlackSignature(signingSecret, signature, timestamp, rawBody)) {
    res.status(401).send('Invalid signature');
    return;
  }

  const params = new URLSearchParams(rawBody);
  const commandText = params.get('text') ?? '';
  const parsed = parseCommand(commandText);

  if (!parsed.ok) {
    res.json({ response_type: 'ephemeral', text: parsed.error });
    return;
  }

  const { app: appName, cycleId } = parsed;

  try {
    await triggerGitHubWorkflow({ app: appName, cycleId });
    res.json({
      response_type: 'in_channel',
      text:
        `*${appName}* cycle *${cycleId}* — tests started on GitHub Actions (CapSolver enabled).\n` +
        `Progress and results will post in this channel.`,
    });
  } catch (err) {
    console.error('trigger:', err);
    res.json({
      response_type: 'ephemeral',
      text: `Failed to start tests: ${err.message}`,
    });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', runner: 'github-actions' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Webhook server on port ${port} — dispatches to GitHub Actions`);
});
