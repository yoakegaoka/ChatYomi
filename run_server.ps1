# Irodori TTS Reader の起動
#
# 使い方:
#   .\run_server.ps1          Irodori-TTS-Server とラッパーを起動する
#   .\run_server.ps1 -IrodoriCheckpoint 'Aratako/Irodori-TTS-v4.1-Small'
#   .\run_server.ps1 -Dummy   Serverなしで起動する（自動検証・開発用）

param(
    [switch]$Dummy,
    [string]$IrodoriServerDir = '',
    [ValidateNotNullOrEmpty()][string]$IrodoriCheckpoint = 'Aratako/Irodori-TTS-500M-v3',
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Get-SavedIrodoriServerDirectory {
    $settingsPath = Join-Path $PSScriptRoot '.local\settings.json'
    if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) { return '' }
    try {
        $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding utf8 | ConvertFrom-Json
        return [string]$settings.irodoriServerDir
    }
    catch { throw '.local/settings.json を読み取れない。setup.cmd をもう一度実行すること。' }
}

function Get-LogTail {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        return ((Get-Content -LiteralPath $Path -Tail 12 -ErrorAction SilentlyContinue) -join [Environment]::NewLine)
    }
    return ''
}

$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    throw '専用仮想環境 .venv が見つからない。.\setup.ps1 を一度実行すること。'
}
& $venvPython -c 'import fastapi, yaml, uvicorn' 2>$null
if ($LASTEXITCODE -ne 0) {
    throw 'ラッパーの依存関係が不足している。.\setup.ps1 をもう一度実行すること。'
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'config.yaml') -PathType Leaf)) {
    throw 'config.yaml が見つからない。.\setup.ps1 を一度実行すること。'
}

if (-not $Dummy) {
    $irodoriServerDir = if ($IrodoriServerDir) { $IrodoriServerDir } else { Get-SavedIrodoriServerDirectory }
    if (-not $irodoriServerDir) { throw 'Irodori-TTS-Server の場所が未設定。.\setup.ps1 -IrodoriServerDir <場所> を実行すること。' }
    if (-not (Test-Path -LiteralPath $irodoriServerDir -PathType Container)) { throw "Irodori-TTS-Server の場所が見つからない: $irodoriServerDir" }
    $uv = Get-Command 'uv' -ErrorAction SilentlyContinue
    if (-not $uv) { throw 'uv が見つからない。Irodori-TTS-Server の公式手順に従って導入すること。' }

    $serverHealth = 'http://127.0.0.1:8088/health'
    $serverInfo = $null
    $launchedServer = $false
    try {
        $serverInfo = Invoke-RestMethod -Uri $serverHealth -TimeoutSec 2
        Write-Host 'Irodori-TTS-Server は既に起動している。' -ForegroundColor Green
    }
    catch {
        $outLog = Join-Path $PSScriptRoot 'irodori_server.out.log'
        $errLog = Join-Path $PSScriptRoot 'irodori_server.err.log'
        Write-Host "Irodori-TTS-Server を起動: $irodoriServerDir" -ForegroundColor DarkGray
        # 子プロセスだけに設定する。上流の .env と親シェルの環境は変更しない。
        $envNames = @('IRODORI_CHECKPOINT', 'IRODORI_HF_CHECKPOINT', 'IRODORI_MODEL_PRECISION', 'IRODORI_CODEC_PRECISION', 'IRODORI_PRELOAD')
        $savedEnv = @{}
        foreach ($name in $envNames) { $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
        try {
            [Environment]::SetEnvironmentVariable('IRODORI_CHECKPOINT', '', 'Process')
            [Environment]::SetEnvironmentVariable('IRODORI_HF_CHECKPOINT', $IrodoriCheckpoint, 'Process')
            [Environment]::SetEnvironmentVariable('IRODORI_MODEL_PRECISION', 'bf16', 'Process')
            [Environment]::SetEnvironmentVariable('IRODORI_CODEC_PRECISION', 'bf16', 'Process')
            [Environment]::SetEnvironmentVariable('IRODORI_PRELOAD', 'true', 'Process')
            $serverProcess = Start-Process -FilePath $uv.Source -ArgumentList 'run', '--no-sync', 'python', '-m', 'irodori_openai_tts', '--host', '127.0.0.1', '--port', '8088' -WorkingDirectory $irodoriServerDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
        }
        finally {
            foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $savedEnv[$name], 'Process') }
        }
        $launchedServer = $true
        for ($i = 0; $i -lt 360; $i++) {
            Start-Sleep -Milliseconds 500
            try { $serverInfo = Invoke-RestMethod -Uri $serverHealth -TimeoutSec 2; break } catch { }
        }
        if (-not $serverInfo) {
            $tail = Get-LogTail $errLog
            $hint = if ($tail) { "`n直近のエラー:`n$tail" } else { "`n$errLog を確認すること。" }
            throw "Irodori-TTS-Server が180秒以内に起動しなかった。GPU、モデル取得、.env、uv を確認すること。$hint"
        }
        Write-Host 'Irodori-TTS-Server: http://127.0.0.1:8088' -ForegroundColor Green
    }
    if (-not $serverInfo.model -or -not $serverInfo.runtime) { throw ':8088 は応答したが、Irodori-TTS-Server の health 情報ではない。ポート使用中のプロセスを確認すること。' }
    $checkpoint = $serverInfo.model.hf_checkpoint
    Write-Host "  checkpoint: $checkpoint"
    if ($checkpoint -ne $IrodoriCheckpoint) {
        throw "起動中のIrodori-TTS-Serverは $checkpoint を使用中。指定した $IrodoriCheckpoint へ稼働中に切り替えることはできない。Serverを停止してから起動し直すこと。"
    }
    if ($launchedServer) {
        $listener = Get-NetTCPConnection -LocalPort 8088 -State Listen -ErrorAction Stop | Select-Object -First 1
        $listenerProcess = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
        $pidFile = Join-Path $PSScriptRoot '.local\irodori-server.pid'
        if (-not (Test-Path -LiteralPath (Split-Path -Parent $pidFile))) { New-Item -ItemType Directory -Path (Split-Path -Parent $pidFile) | Out-Null }
        [IO.File]::WriteAllText($pidFile, "$($listenerProcess.Id)|$($listenerProcess.StartTime.ToUniversalTime().Ticks)")
    }
}

$argsList = @('-m', 'server.main', '--backend', $(if ($Dummy) { 'dummy' } else { 'irodori_server' }))
if ($Port -gt 0) { $argsList += @('--port', "$Port") }
$uiPort = if ($Port -gt 0) { $Port } else { 8080 }
Write-Host ''
Write-Host "管理UI: http://127.0.0.1:$uiPort/admin" -ForegroundColor Green
Write-Host '停止:   .\stop_server.ps1' -ForegroundColor DarkGray
Write-Host ''
& $venvPython @argsList
