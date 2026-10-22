# Start SecondBrain on the Jesster notes kernel (Windows).
#   Right-click > Run with PowerShell, or double-click start-secondbrain.cmd.
# First run: builds the UI and makes the vault. Later updates: the Update
# button in the app header (or `python notes\cli.py update`).
param(
  [string]$Vault = "$HOME\JessterNotes",
  [int]$Port = 43111,
  [string]$Actor = $env:USERNAME
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Need($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Host "Missing $name - $hint" -ForegroundColor Red
    Read-Host "Press Enter to close"; exit 1
  }
}
Need git "install from https://git-scm.com"
Need node "install Node.js 22 LTS from https://nodejs.org"
# (Windows PowerShell 5.1 has no ?: operator)
if (Get-Command py -ErrorAction SilentlyContinue) { $py = "py" } else { $py = "python" }
Need $py "install Python 3.12 from https://python.org (tick 'Add to PATH')"

if (-not (Test-Path "secondbrain\dist\index.html")) {
  Write-Host "Building the SecondBrain UI (first run only)..." -ForegroundColor Cyan
  Push-Location secondbrain
  npm ci --legacy-peer-deps --ignore-scripts
  npm run build
  Pop-Location
}

$env:JESSTER_VAULT = $Vault
if (-not (Test-Path "$Vault\.jesster\config.json")) {
  & $py notes\cli.py init --actor $Actor | Out-Null
  Write-Host "Made a vault at $Vault (deposits signed as '$Actor')." -ForegroundColor Cyan
}

Start-Process "http://localhost:$Port/"
Write-Host "SecondBrain: http://localhost:$Port/   (Ctrl+C to stop)" -ForegroundColor Green
& $py notes\cli.py serve --port $Port
