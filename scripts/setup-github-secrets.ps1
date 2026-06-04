# Sets GitHub Actions secrets from environment variables (or a .env file in repo root).
# Requires: gh CLI, active account with repo admin access.
# Usage: copy .env.example to .env, fill values, then: .\scripts\setup-github-secrets.ps1

$ErrorActionPreference = 'Stop'
$repo = 'vishalegnition/egnition-qa-runner'
$root = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $root '.env'

if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$' -and $_ -notmatch '^\s*#') {
      $name = $Matches[1]
      $val = $Matches[2].Trim().Trim('"').Trim("'")
      if ($val) { Set-Item -Path "env:$name" -Value $val }
    }
  }
}

$secrets = @(
  'SHOPIFY_ADMIN_EMAIL',
  'SHOPIFY_ADMIN_PASSWORD',
  'ZEPHYR_BASE_URL',
  'ZEPHYR_API_TOKEN',
  'ZEPHYR_PROJECT_KEY',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'SLACK_BOT_TOKEN',
  'SLACK_CHANNEL_ID'
)

foreach ($name in $secrets) {
  $val = [Environment]::GetEnvironmentVariable($name)
  if (-not $val) {
    Write-Warning "Skip $name (not set)"
    continue
  }
  Write-Host "Setting secret $name ..."
  $val | gh secret set $name --repo $repo
}

Write-Host "Done. List secrets: gh secret list --repo $repo"
