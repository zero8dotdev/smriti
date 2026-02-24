<#
.SYNOPSIS
  Smriti installer for Windows
.DESCRIPTION
  Installs smriti — shared memory layer for AI agents.
  Requires: Git, PowerShell 5.1+, Windows 10+
  Bun is installed automatically if not present.

.PARAMETER CI
  Non-interactive mode for GitHub Actions / automated environments.
  Uses a temp directory and skips hook registration.

.EXAMPLE
  # Interactive (paste in PowerShell):
  irm https://raw.githubusercontent.com/zero8dotdev/smriti/main/install.ps1 | iex

  # CI / non-interactive:
  pwsh install.ps1 -CI
#>
param(
  [switch]$CI
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ─── Config ──────────────────────────────────────────────────────────────────
if ($CI) {
  $HOME_DIR     = Join-Path ([System.IO.Path]::GetTempPath()) "smriti-ci-home"
  $null         = New-Item -ItemType Directory -Force -Path $HOME_DIR
  $env:USERPROFILE = $HOME_DIR
  Write-Host "CI mode: using temp HOME $HOME_DIR"
}

$SMRITI_HOME  = Join-Path $env:USERPROFILE ".smriti"
$BIN_DIR      = Join-Path $env:USERPROFILE ".local\bin"
$REPO_URL     = "https://github.com/zero8dotdev/smriti.git"
$CLAUDE_HOOKS = Join-Path $env:USERPROFILE ".claude\hooks"

# ─── Helpers ─────────────────────────────────────────────────────────────────
function Step([string]$msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok([string]$msg)    { Write-Host "  OK $msg" -ForegroundColor Green }
function Warn([string]$msg)  { Write-Host "  !  $msg" -ForegroundColor Yellow }

# ─── Git ─────────────────────────────────────────────────────────────────────
Step "Checking prerequisites"
try { $null = git --version 2>&1; Ok "Git found" }
catch { Write-Error "Git is required. Install from https://git-scm.com" }

# ─── Bun ─────────────────────────────────────────────────────────────────────
Step "Checking Bun"
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host "  Installing Bun..."
  powershell -c "irm bun.sh/install.ps1 | iex"
  $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","User") + ";$env:PATH"
} else {
  Ok "Bun $(bun --version)"
}

# ─── Clone / update smriti ───────────────────────────────────────────────────
Step "Installing smriti to $SMRITI_HOME"
if (Test-Path (Join-Path $SMRITI_HOME ".git")) {
  Push-Location $SMRITI_HOME; git pull --quiet; Pop-Location
  Ok "Updated"
} else {
  git clone --quiet $REPO_URL $SMRITI_HOME
  Ok "Cloned"
}
Push-Location $SMRITI_HOME; bun install --silent; Pop-Location
Ok "Dependencies installed"

# ─── smriti.cmd shim ─────────────────────────────────────────────────────────
Step "Creating smriti command"
$null = New-Item -ItemType Directory -Force -Path $BIN_DIR
$shimPath = Join-Path $BIN_DIR "smriti.cmd"
Set-Content -Path $shimPath -Encoding ASCII -Value "@echo off`r`nbun `"$SMRITI_HOME\src\index.ts`" %*"
Ok "smriti.cmd -> $BIN_DIR"

# Add BIN_DIR to user PATH
$userPath = [System.Environment]::GetEnvironmentVariable("PATH","User")
if ($userPath -notlike "*$BIN_DIR*") {
  [System.Environment]::SetEnvironmentVariable("PATH","$userPath;$BIN_DIR","User")
  $env:PATH += ";$BIN_DIR"
  Ok "Added $BIN_DIR to PATH"
}

# ─── Claude Code hook (skip in CI) ───────────────────────────────────────────
if (-not $CI -and (Test-Path $CLAUDE_HOOKS)) {
  Step "Configuring Claude Code hook"
  $hook = Join-Path $CLAUDE_HOOKS "post-session.cmd"
  Set-Content -Path $hook -Encoding ASCII -Value "@echo off`r`nbun `"$SMRITI_HOME\src\index.ts`" ingest claude >nul 2>&1"
  Ok "Hook installed: $hook"
} elseif (-not $CI) {
  Warn "Claude Code hooks dir not found ($CLAUDE_HOOKS) — skipping hook"
  Warn "Run 'smriti daemon start' for automatic ingestion (v0.4.0+)"
}

# ─── Done ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Smriti installed!" -ForegroundColor Green
Write-Host "  Restart your terminal, then:" -ForegroundColor Gray
Write-Host "    smriti ingest claude" -ForegroundColor White
Write-Host "    smriti ingest copilot" -ForegroundColor White
Write-Host "    smriti status" -ForegroundColor White
Write-Host ""
