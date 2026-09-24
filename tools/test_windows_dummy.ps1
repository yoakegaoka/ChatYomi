# GPU を使わない Windows 導入経路の自動検証。
# 実行: .\tools\test_windows_dummy.ps1

param([int]$Port = 18080)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$configPath = Join-Path $root 'config.yaml'
$before = if (Test-Path -LiteralPath $configPath) { (Get-FileHash -Algorithm SHA256 -LiteralPath $configPath).Hash } else { '' }

& (Join-Path $root 'setup.ps1') -Dummy
if ($LASTEXITCODE -ne 0) { throw 'Dummy セットアップに失敗した。' }
if (-not (Test-Path -LiteralPath (Join-Path $root '.venv\Scripts\python.exe'))) { throw '.venv が作成されていない。' }
$after = if (Test-Path -LiteralPath $configPath) { (Get-FileHash -Algorithm SHA256 -LiteralPath $configPath).Hash } else { '' }
if ($before -and $before -ne $after) { throw '既存 config.yaml が変更された。' }
& (Join-Path $root 'setup.ps1') -Dummy
if ($LASTEXITCODE -ne 0) { throw 'Dummy セットアップの再実行に失敗した。' }
$rerun = if (Test-Path -LiteralPath $configPath) { (Get-FileHash -Algorithm SHA256 -LiteralPath $configPath).Hash } else { '' }
if ($after -ne $rerun) { throw '再実行で config.yaml が変更された。' }

$outLog = Join-Path $root 'dummy_setup_test.out.log'
$errLog = Join-Path $root 'dummy_setup_test.err.log'
$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'run_server.ps1'), '-Dummy', '-Port', $Port -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
        if ($health.status -eq 'ok') { $ready = $true; break }
    }
    catch { }
}
if (-not $ready) {
    $tail = if (Test-Path -LiteralPath $errLog) { (Get-Content -LiteralPath $errLog -Tail 20) -join [Environment]::NewLine } else { '' }
    throw "Dummy ラッパーが起動しない。$tail"
}

& (Join-Path $root 'stop_server.ps1') -Port $Port
if ($LASTEXITCODE -ne 0) { throw 'Dummy ラッパーの停止に失敗した。' }
$proc.WaitForExit(10000) | Out-Null
Write-Host '[完了] Dummy 構成のセットアップ・起動・health・停止を確認した。' -ForegroundColor Green
