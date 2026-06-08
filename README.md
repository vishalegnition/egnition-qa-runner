# Egnition QA Runner

Shopify QA browser automation: trigger regression tests from Slack, run headed Chrome tests via Playwright on GitHub Actions, with steps from Zephyr Scale and vision AI via OpenRouter.

## Architecture

| Component | Location | Role |
|-----------|----------|------|
| Webhook + browser runner | `webhook/` on Railway | Slack slash command → headed Chrome tests on Railway (Xvfb) |
| Test runner (optional) | `runner/` on GitHub Actions | Same runner if `RUN_TESTS_ON_GITHUB=true` on Railway |
| App config | `config/apps.json` | App name → Shopify dev store URL |

## Slack command

```
/run-tests [app] [cycle-id]
```

Valid apps: `br` (BestSellers reSort), `oosp` (StockIQ), `mssp` (Multi-Store Sync Power), `ol` (Commetiq Order Limits)

Cycle keys follow your Zephyr naming, e.g. `BR-R104` for a BestSellers reSort test cycle:

```
/run-tests br BR-R104
```

**Repository:** https://github.com/vishalegnition/egnition-qa-runner

See [SETUP_STATUS.md](SETUP_STATUS.md) for automated setup progress and remaining one-time steps.

## Setup

### 1. GitHub repository secrets

Configure in **Settings → Secrets and variables → Actions**:

- `SHOPIFY_SESSION_COOKIES` — Cookie-Editor JSON from your shared dev store admin (one login for all apps; refresh ~yearly)
- `ZEPHYR_API_TOKEN` (Zephyr Scale Cloud API — cycles like `BR-R104`)
- `OPENROUTER_API_KEY` (model is auto-selected from available Gemini vision models)
- `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`

### 2. App store URLs

Edit `config/apps.json` with your real shared dev store URL on every app entry (all apps run in the same Shopify store).

### 3. Railway webhook

Deploy to Railway. Set:

- `SLACK_SIGNING_SECRET`
- `SHOPIFY_SESSION_COOKIES` (same Cookie-Editor JSON as GitHub)
- `ZEPHYR_API_TOKEN`, `OPENROUTER_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`
- Optional: `CAPSOLVER_API_KEY`, `GITHUB_TOKEN` (only if `RUN_TESTS_ON_GITHUB=true`)

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
CYCLE_ID=BR-R104 node runner/zephyr.js

# Run full cycle (headed locally — omit Xvfb on Windows/Mac)
APP=br CYCLE_ID=BR-R104 node runner/index.js

# Webhook receiver
npm run webhook
```

## Manual workflow trigger

In GitHub: **Actions → Run QA Browser Tests → Run workflow**, enter `app` and `cycle_id`.

## Build order (from spec)

1. Repo scaffold ✓
2. `zephyr.js` — `node runner/zephyr.js BR-R104`
3. `browser.js` — login via Actions or local
4. `vision.js` — OpenRouter with screenshot
5. `runner/index.js` — full cycle + Slack report
6. Railway webhook + Slack slash command wired
