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

### 1. GitHub Actions secrets (no values on this machine)

No `.env` file and no secrets configured in the repo yet. Required before any test run.

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
