<#
.SYNOPSIS
  Smriti uninstaller for Windows
.PARAMETER CI
  Non-interactive mode. Removes the CI temp home created by install.ps1 -CI.
.EXAMPLE
  irm https://raw.githubusercontent.com/zero8dotdev/smriti/main/uninstall.ps1 | iex
#>
param([switch]$CI)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($CI) {
  $HOME_DIR = Join-Path ([System.IO.Path]::GetTempPath()) "smriti-ci-home"
  $env:USERPROFILE = $HOME_DIR
}

$SMRITI_HOME  = Join-Path $env:USERPROFILE ".smriti"
$BIN_DIR      = Join-Path $env:USERPROFILE ".local\bin"
$CLAUDE_HOOKS = Join-Path $env:USERPROFILE ".claude\hooks"

function Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok([string]$msg)   { Write-Host "  OK $msg" -ForegroundColor Green }

# Remove smriti installation directory
Step "Removing smriti"
if (Test-Path $SMRITI_HOME) {
  Remove-Item -Recurse -Force $SMRITI_HOME
  Ok "Removed $SMRITI_HOME"
} else {
  Ok "Not found: $SMRITI_HOME (already removed)"
}

# Remove smriti.cmd shim
$shimPath = Join-Path $BIN_DIR "smriti.cmd"
if (Test-Path $shimPath) {
  Remove-Item -Force $shimPath
  Ok "Removed $shimPath"
}

# Remove BIN_DIR from user PATH if it's now empty
$remaining = Get-ChildItem $BIN_DIR -ErrorAction SilentlyContinue
if (-not $remaining) {
  $userPath = [System.Environment]::GetEnvironmentVariable("PATH","User")
  $cleaned  = ($userPath -split ";") | Where-Object { $_ -ne $BIN_DIR } | Join-String -Separator ";"
  [System.Environment]::SetEnvironmentVariable("PATH",$cleaned,"User")
  Ok "Removed $BIN_DIR from PATH"
}

# Remove Claude Code hook
$hook = Join-Path $CLAUDE_HOOKS "post-session.cmd"
if (Test-Path $hook) {
  Remove-Item -Force $hook
  Ok "Removed Claude Code hook"
}

# Remove daemon files
$daemonDir = Join-Path $env:USERPROFILE ".cache\smriti"
if (Test-Path $daemonDir) {
  Remove-Item -Recurse -Force $daemonDir
  Ok "Removed daemon cache"
}

Write-Host ""
Write-Host "  Smriti uninstalled." -ForegroundColor Green
Write-Host "  Your database (~/.cache/qmd/index.sqlite) was NOT removed." -ForegroundColor Gray
Write-Host "  To also remove the database, delete: $(Join-Path $env:USERPROFILE '.cache\qmd')" -ForegroundColor Gray
Write-Host ""
