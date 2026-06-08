# Setup status (auto-generated)

## Completed locally

- [x] Full codebase implemented per spec
- [x] `npm install` + Playwright Chromium installed
- [x] `npm run verify` — all checks pass
- [x] Browser smoke test (`node scripts/smoke-browser.js`)
- [x] Git repo initialized, committed on `main`
- [x] GitHub repo created: **https://github.com/vishalegnition/egnition-qa-runner**
- [x] Application code pushed to `main`

## Completed on GitHub

- [x] GitHub Actions workflow pushed — **Run QA Browser Tests** is active
- [x] `workflow` scope granted on `vishalegnition` account

## Still needed

### 1. GitHub Actions secrets

**Set on GitHub (auto):**
- [x] `ZEPHYR_BASE_URL` → `https://egnition.atlassian.net`

**No longer required:** `OPENROUTER_MODEL` — best Gemini vision model is auto-selected at runtime.

**You still need to add in GitHub → Settings → Secrets → Actions:**
- [ ] `SHOPIFY_ADMIN_EMAIL`
- [ ] `SHOPIFY_ADMIN_PASSWORD`
- [ ] `SHOPIFY_2FA_SECRET` (TOTP secret — not a one-time code)
- [ ] `ZEPHYR_API_TOKEN`
- [ ] `OPENROUTER_API_KEY`
- [ ] `SLACK_BOT_TOKEN` (scopes: `chat:write`, `files:write`, `channels:read`, `groups:read`)
- [ ] `SLACK_CHANNEL_ID`

### 2. Railway webhook deploy

- [x] Deployed to **https://qa-automation-production-9b20.up.railway.app**
- [x] `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME`, `GITHUB_TOKEN` set on Railway
- [ ] `SLACK_SIGNING_SECRET` — still required on Railway
- [ ] Slack slash command URL → `https://qa-automation-production-9b20.up.railway.app/trigger`

### 3. GitHub Actions secrets

After `.env` is filled from `.env.example`:

```powershell
.\scripts\setup-github-secrets.ps1
```

### 4. Real Shopify dev store URLs

Edit `config/apps.json` with production dev store URLs, commit, and push.
