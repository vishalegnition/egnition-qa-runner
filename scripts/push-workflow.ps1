# Run after: gh auth refresh -h github.com -s repo,workflow
# Then: git push origin main

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

git checkout main
if (Test-Path .github/workflows/run-tests.yml) {
  git add .github/workflows/run-tests.yml
  git commit -m "ci: add GitHub Actions run-tests workflow" 2>$null
}
git push origin main
Write-Host "Workflow pushed. Verify at: https://github.com/vishalegnition/egnition-qa-runner/actions"
