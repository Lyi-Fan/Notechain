param([switch]$Qa)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$repo = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $repo
try {
    if ($env:OS -ne 'Windows_NT') { throw 'Run this script on Windows. See docs/windows/BUILD.md for cross-compilation.' }
    foreach ($name in @('node.exe', 'npm.cmd', 'cargo.exe')) {
        if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "Missing prerequisite: $name" }
    }
    $buildArgs = @('tauri', 'build', '--bundles', 'nsis')
    if ($Qa) { $buildArgs += @('--features', 'qa') }
    & npx.cmd @buildArgs
    if ($LASTEXITCODE -ne 0) { throw 'Windows application build failed' }
} finally { Pop-Location }
