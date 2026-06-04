# Setup status (auto-generated)

## Completed locally

- [x] Full codebase implemented per spec
- [x] `npm install` + Playwright Chromium installed
- [x] `npm run verify` — all checks pass
- [x] Browser smoke test (`node scripts/smoke-browser.js`)
- [x] Git repo initialized, committed on `main`
- [x] GitHub repo created: **https://github.com/vishalegnition/egnition-qa-runner**
- [x] Application code pushed to `main`

## Blocked (needs one browser step on your machine)

### 1. GitHub Actions workflow file

The `vishalegnition` GitHub OAuth token has `repo` but not `workflow` scope, so `.github/workflows/run-tests.yml` cannot be pushed yet.

**Fix (once, ~30 seconds):**

```powershell
gh auth refresh -h github.com -s repo,workflow
cd "d:\QA Automation Testing"
.\scripts\push-workflow.ps1
```

A prior `gh auth refresh` attempt failed (device code expired). Run refresh again and complete login within 15 minutes.

### 2. Railway webhook deploy

`railway` CLI is not logged in on this machine.

```powershell
railway login
cd "d:\QA Automation Testing"
railway init
railway up
railway variables set SLACK_SIGNING_SECRET=... GITHUB_TOKEN=... GITHUB_REPO_OWNER=vishalegnition GITHUB_REPO_NAME=egnition-qa-runner
```

Set Slack slash command URL to: `https://<railway-domain>/trigger`

### 3. GitHub Actions secrets

After `.env` is filled from `.env.example`:

```powershell
.\scripts\setup-github-secrets.ps1
```

### 4. Real Shopify dev store URLs

Edit `config/apps.json` with production dev store URLs, commit, and push.
