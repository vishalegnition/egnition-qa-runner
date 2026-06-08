# Setup status

## Complete

- [x] Codebase + GitHub repo: https://github.com/vishalegnition/egnition-qa-runner
- [x] GitHub Actions workflow: **Run QA Browser Tests**
- [x] Railway webhook: https://qa-automation-production-9b20.up.railway.app
- [x] App codes: `br`, `oosp`, `mssp`, `ol`
- [x] GitHub Actions secrets (all 8):
  - `SHOPIFY_ADMIN_EMAIL`, `SHOPIFY_ADMIN_PASSWORD`, `SHOPIFY_2FA_SECRET`
  - `ZEPHYR_BASE_URL`, `ZEPHYR_API_TOKEN`
  - `OPENROUTER_API_KEY`
  - `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`
- [x] Railway variables: `SLACK_SIGNING_SECRET`, `GITHUB_*`

## First test

**From Slack:**
```
/run-tests br CYCLE-42
```
(Replace `CYCLE-42` with a real Zephyr cycle ID.)

**Or from GitHub:** Actions → Run QA Browser Tests → Run workflow → `app: br`, `cycle_id: CYCLE-42`

## Optional

- [ ] Replace placeholder Shopify store URLs in `config/apps.json`
- [ ] Confirm Slack slash command URL points to `https://qa-automation-production-9b20.up.railway.app/trigger`
