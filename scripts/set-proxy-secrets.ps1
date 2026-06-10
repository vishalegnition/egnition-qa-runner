# Set CAPSOLVER_PROXY on GitHub Actions + Railway.
# Requires: gh CLI, Railway CLI with RAILWAY_TOKEN, sticky residential proxy.
#
# Usage:
#   $env:CAPSOLVER_PROXY = "host:port:user:pass"
#   .\scripts\set-proxy-secrets.ps1

$ErrorActionPreference = 'Stop'
$repo = 'vishalegnition/egnition-qa-runner'
$railwayService = '33be08c9-9b86-400f-a949-1e8269531416'

if (-not $env:CAPSOLVER_PROXY) {
  Write-Host 'Set CAPSOLVER_PROXY first, e.g.:'
  Write-Host '  $env:CAPSOLVER_PROXY = "1.2.3.4:12321:user:pass"'
  exit 1
}

Write-Host "Setting CAPSOLVER_PROXY on GitHub ($repo)..."
gh secret set CAPSOLVER_PROXY --repo $repo --body $env:CAPSOLVER_PROXY

if ($env:RAILWAY_TOKEN) {
  Write-Host 'Setting CAPSOLVER_PROXY on Railway...'
  railway variables --service $railwayService --set "CAPSOLVER_PROXY=$($env:CAPSOLVER_PROXY)"
  Write-Host 'Redeploying Railway...'
  railway redeploy -y --service $railwayService
} else {
  Write-Host 'RAILWAY_TOKEN not set — add CAPSOLVER_PROXY manually in Railway dashboard, then redeploy.'
}

Write-Host 'Done. Re-run /run-tests in Slack.'
