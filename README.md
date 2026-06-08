# Egnition QA Runner

Shopify QA browser automation: trigger regression tests from Slack, run headed Chrome tests via Playwright on GitHub Actions, with steps from Zephyr Scale and vision AI via OpenRouter.

## Architecture

| Component | Location | Role |
|-----------|----------|------|
| Webhook receiver | `webhook/` on Railway | Slack slash command → GitHub Actions dispatch |
| Test runner | `runner/` on GitHub Actions | Zephyr fetch → Playwright + vision loop → Slack report |
| App config | `config/apps.json` | App name → Shopify dev store URL |

## Slack command

```
/run-tests [app] [cycle-id]
```

Valid apps: `br` (BestSellers reSort), `oosp` (StockIQ), `mssp` (Multi-Store Sync Power), `ol` (Commetiq Order Limits)

**Repository:** https://github.com/vishalegnition/egnition-qa-runner

See [SETUP_STATUS.md](SETUP_STATUS.md) for automated setup progress and remaining one-time steps.

## Setup

### 1. GitHub repository secrets

Configure in **Settings → Secrets and variables → Actions**:

- `SHOPIFY_ADMIN_EMAIL`, `SHOPIFY_ADMIN_PASSWORD`, `SHOPIFY_2FA_SECRET` (TOTP secret for 2FA — generates codes automatically)
- `ZEPHYR_BASE_URL`, `ZEPHYR_API_TOKEN`
- `OPENROUTER_API_KEY` (model is auto-selected from available Gemini vision models)
- `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`

### 2. App store URLs

Edit `config/apps.json` with real Shopify dev store URLs before the first run.

### 3. Railway webhook

Deploy `webhook/index.js` to Railway. Set:

- `SLACK_SIGNING_SECRET`
- `GITHUB_TOKEN` (PAT with `repo` + `workflow` scope)
- `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`

Point the Slack slash command Request URL to: `https://<your-railway-app>/trigger`

### 4. Slack app

**How instructions reach the runner:** `/run-tests` is a **slash command**. Slack sends the command text to the Railway webhook (`/trigger`). That is verified with `SLACK_SIGNING_SECRET` — not the bot token. The bot token is only used to **post results back** to the channel.

**Bot Token Scopes** (OAuth & Permissions → Bot Token Scopes):

| Scope | Why |
|-------|-----|
| `chat:write` | Post the QA summary report |
| `files:write` | Upload pass/fail screenshots |
| `channels:read` | See public channel info (e.g. validate `SLACK_CHANNEL_ID`) |
| `groups:read` | Same for **private** QA channels |
| `chat:write.public` | Optional — post to a public channel without `/invite` |

You do **not** need `channels:history` or `channels:read` to receive `/run-tests` — that comes through the slash-command webhook.

**Also configure:**
- Slash command `/run-tests` → `https://qa-automation-production-9b20.up.railway.app/trigger`
- Install app to workspace → copy `xoxb-...` bot token
- Basic Information → copy **Signing Secret** → Railway `SLACK_SIGNING_SECRET`
- `/invite` the bot to your QA channel; copy channel ID (`C...`) → GitHub `SLACK_CHANNEL_ID`

## Local development

```bash
cp .env.example .env
# fill in secrets
npm install
npx playwright install chromium

# Test Zephyr fetch
CYCLE_ID=CYCLE-42 node runner/zephyr.js

# Run full cycle (headed locally — omit Xvfb on Windows/Mac)
APP=br CYCLE_ID=CYCLE-42 node runner/index.js

# Webhook receiver
npm run webhook
```

## Manual workflow trigger

In GitHub: **Actions → Run QA Browser Tests → Run workflow**, enter `app` and `cycle_id`.

## Build order (from spec)

1. Repo scaffold ✓
2. `zephyr.js` — `node runner/zephyr.js CYCLE-42`
3. `browser.js` — login via Actions or local
4. `vision.js` — OpenRouter with screenshot
5. `runner/index.js` — full cycle + Slack report
6. Railway webhook + Slack slash command wired
