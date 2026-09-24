# 初回セットアップと診断（Irodori-TTS-Server + v3 構成）
#
# 使い方:
#   .\setup.ps1 -IrodoriServerDir 'D:\path\to\Irodori-TTS-Server'
#   .\setup.ps1 -Dummy  # GPU や Irodori-TTS なしでラッパーだけ確認する
#
# Irodori-TTS-Server 側の設定ファイルは変更しない。

param(
    [string]$IrodoriServerDir = '',
    [switch]$Interactive,
    [switch]$Dummy,
    [switch]$SkipWrapperDependencies
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$recommendedCheckpoint = 'Aratako/Irodori-TTS-500M-v3'
$problems = New-Object System.Collections.Generic.List[string]
$notices = New-Object System.Collections.Generic.List[string]

$localDir = Join-Path $PSScriptRoot '.local'
$localSettingsPath = Join-Path $localDir 'settings.json'

function Get-SavedIrodoriServerDirectory {
    if (-not (Test-Path -LiteralPath $localSettingsPath -PathType Leaf)) { return '' }
    try {
        $settings = Get-Content -LiteralPath $localSettingsPath -Raw -Encoding utf8 | ConvertFrom-Json
        return [string]$settings.irodoriServerDir
    }
    catch {
        $problems.Add('.local/settings.json を読み取れない')
        return ''
    }
}

function Write-LocalSettings {
    param([hashtable]$Data)
    if (-not (Test-Path -LiteralPath $localDir -PathType Container)) {
        New-Item -ItemType Directory -Path $localDir | Out-Null
    }
    $json = $Data | ConvertTo-Json
    [IO.File]::WriteAllText($localSettingsPath, $json + [Environment]::NewLine,
        (New-Object Text.UTF8Encoding($false)))
}

function Save-IrodoriServerDirectory {
    param([string]$Path)
    $data = @{ irodoriServerDir = $Path }
    if (Test-Path -LiteralPath $localSettingsPath -PathType Leaf) {
        try {
            $old = Get-Content -LiteralPath $localSettingsPath -Raw -Encoding utf8 | ConvertFrom-Json
            if ([string]$old.irodoriServerDir -eq $Path) {
                foreach ($property in $old.PSObject.Properties) {
                    if ($property.Name -ne 'irodoriServerDir') { $data[$property.Name] = $property.Value }
                }
            }
        }
        catch { }
    }
    Write-LocalSettings -Data $data
}

function Write-Check {
    param([string]$Label, [bool]$Ok, [string]$Detail = '')
    $mark = if ($Ok) { '[OK]' } else { '[要対応]' }
    $color = if ($Ok) { 'Green' } else { 'Yellow' }
    Write-Host "$mark $Label" -ForegroundColor $color
    if ($Detail) { Write-Host "     $Detail" -ForegroundColor DarkGray }
}


function Get-ListenerDescription {
    param([int]$Port)
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if (-not $conn) { return '' }
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction Stop
        return "使用中: $($proc.ProcessName) (PID $($proc.Id))"
    }
    catch { return '' }
}

function Find-SystemPython {
    $python = Get-Command 'python' -ErrorAction SilentlyContinue
    if (-not $python) { return $null }
    try {
        $version = (& $python.Source --version 2>&1 | Select-Object -First 1).ToString()
        if ($version -match 'Python\s+(\d+\.\d+)' -and [version]$Matches[1] -ge [version]'3.11') {
            return $python.Source
        }
        Write-Check 'Python' $false "$version （3.11以上が必要）"
    }
    catch { Write-Check 'Python' $false 'バージョンを確認できない。' }
    return $null
}

function Select-IrodoriServerDirectory {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = 'Irodori-TTS-Server のフォルダーを選択してください'
        $dialog.ShowNewFolderButton = $false
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            return $dialog.SelectedPath
        }
    }
    catch {
        Write-Host 'フォルダー選択画面を開けなかった。' -ForegroundColor Yellow
    }
    return ''
}
function Confirm-Action {
    param([string]$Message)
    $answer = Read-Host "$Message [Y/n]"
    return (-not $answer -or $answer -match '^[Yy]')
}

Write-Host ''
Write-Host 'Irodori-TTS 読み上げ 初回セットアップ' -ForegroundColor Cyan
Write-Host ''

# --- このリポジトリ専用の Python 環境 -----------------------------------
$systemPython = Find-SystemPython
if (-not $systemPython) {
    Write-Check 'Python' $false 'Python 3.11以上をインストールし、PATHへ追加する。'
    $problems.Add('Python 3.11以上が見つからない')
}
else {
    Write-Check 'Python' $true ((& $systemPython --version 2>&1 | Select-Object -First 1).ToString())
    $venvDir = Join-Path $PSScriptRoot '.venv'
    $venvPython = Join-Path $venvDir 'Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        Write-Host 'このリポジトリ専用の .venv を作成中...' -ForegroundColor DarkGray
        & $systemPython -m venv $venvDir
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPython)) {
            throw '.venv を作成できなかった。Python の venv 機能を確認すること。'
        }
    }
    Write-Check '専用仮想環境' $true $venvDir

    if ($SkipWrapperDependencies) {
        $notices.Add('ラッパーの依存関係の更新をスキップした。')
    }
    else {
        Write-Host 'ラッパーの依存関係を確認・導入中...' -ForegroundColor DarkGray
        & $venvPython -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
        if ($LASTEXITCODE -ne 0) {
            throw 'ラッパーの依存関係を導入できなかった。ネットワーク、Python、上の pip メッセージを確認すること。'
        }
    }
    & $venvPython -c 'import fastapi, yaml, uvicorn' 2>$null
    $dependenciesOk = $LASTEXITCODE -eq 0
    Write-Check 'ラッパーの依存関係' $dependenciesOk '.venv を使用する。'
    if (-not $dependenciesOk) { $problems.Add('ラッパーの依存関係が未導入') }
}

# --- 本プロジェクトの設定 ------------------------------------------------
$configPath = Join-Path $PSScriptRoot 'config.yaml'
$configExample = Join-Path $PSScriptRoot 'config.example.yaml'
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    Write-Check 'config.yaml' $true '既存の設定を使用する（変更しない）。'
}
elseif (Test-Path -LiteralPath $configExample -PathType Leaf) {
    Copy-Item -LiteralPath $configExample -Destination $configPath -ErrorAction Stop
    Write-Check 'config.yaml' $true 'config.example.yaml から新規作成した。'
    $notices.Add('LAN公開する場合だけ、起動前に config.yaml の host と api_token を変更する。')
}
else {
    Write-Check 'config.yaml' $false 'config.example.yaml が見つからない。'
    $problems.Add('config.example.yaml が見つからない')
}

if ($Dummy) {
    Write-Check 'Irodori-TTS-Server' $true 'Dummy 構成のため確認を省略した。'
}
else {
    # --- Irodori-TTS-Server ------------------------------------------------
    if (-not $IrodoriServerDir) {
        $savedServerDir = Get-SavedIrodoriServerDirectory
        if ($savedServerDir -and $Interactive) {
            Write-Host "保存済みのIrodori-TTS-Server: $savedServerDir" -ForegroundColor DarkGray
            if (Confirm-Action 'このフォルダーを使用しますか？') {
                $IrodoriServerDir = $savedServerDir
            }
            else {
                $IrodoriServerDir = Select-IrodoriServerDirectory
            }
        }
        else {
            $IrodoriServerDir = $savedServerDir
        }
    }

    if (-not $IrodoriServerDir -and $Interactive) {
        Write-Host 'Irodori-TTS-Server のフォルダーを選択してください。' -ForegroundColor Cyan
        $IrodoriServerDir = Select-IrodoriServerDirectory
    }
    if (-not $IrodoriServerDir) {
        Write-Check 'Irodori-TTS-Server の場所' $false '-IrodoriServerDir で指定する。'
        $problems.Add('Irodori-TTS-Server の場所が未設定')
    }
    elseif (-not (Test-Path -LiteralPath $IrodoriServerDir -PathType Container)) {
        Write-Check 'Irodori-TTS-Server の場所' $false $IrodoriServerDir
        $problems.Add('Irodori-TTS-Server の場所が存在しない')
    }
    elseif (-not (Test-Path -LiteralPath (Join-Path $IrodoriServerDir 'pyproject.toml') -PathType Leaf)) {
        Write-Check 'Irodori-TTS-Server の場所' $false 'pyproject.toml がない。Serverのルートフォルダーを選択する。'
        $problems.Add('選択した場所がIrodori-TTS-Serverではない')
    }
    else {
        $resolvedServerDir = (Resolve-Path -LiteralPath $IrodoriServerDir).Path
        Save-IrodoriServerDirectory -Path $resolvedServerDir
        $notices.Add('Irodori-TTS-Server の場所を .local/settings.json へ保存した。')
        Write-Check 'Irodori-TTS-Server の場所' $true $resolvedServerDir

        $uv = Get-Command 'uv' -ErrorAction SilentlyContinue
        $uvDetail = if ($uv) { $uv.Source } else { '公式手順に従って uv をインストールする。' }
        Write-Check 'Irodori-TTS-Server 用 uv' ([bool]$uv) $uvDetail
        if (-not $uv) { $problems.Add('uv が見つからない') }

        Write-Check 'Irodori-TTS-Server 設定' $true '上流の .env は変更しない。通常の起動ではv3 / bf16を指定する。'
    }

    try {
        $serverHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8088/health' -TimeoutSec 2
        $actual = $serverHealth.model.hf_checkpoint
        $isV3 = $actual -eq $recommendedCheckpoint
        if ($isV3) { Write-Check '起動中のIrodori-TTS-Server' $true "checkpoint: $actual" }
        else { Write-Host "[情報] 起動中のServerは $actual。ChatYomiからの起動前に停止する。" -ForegroundColor Yellow }
        if (-not $isV3) { $notices.Add('起動中のServerはv3ではない。通常のstart.cmdで起動するには、そのServerを停止する。') }
    }
    catch { Write-Host '[情報] Irodori-TTS-Server はまだ起動していない。起動時に確認する。' -ForegroundColor DarkGray }
}

foreach ($port in 8080, 8088) {
    $listener = Get-ListenerDescription -Port $port
    if ($listener) { $notices.Add(":$port は $listener") }
}

Write-Host ''
foreach ($notice in $notices) { Write-Host "[情報] $notice" -ForegroundColor DarkGray }
if ($problems.Count -eq 0) {
    Write-Host '[完了] 起動準備ができた。次は .\run_server.ps1 を実行する。' -ForegroundColor Green
    exit 0
}
Write-Host '[未完了] 次を解決してからもう一度 .\setup.ps1 を実行する。' -ForegroundColor Yellow
foreach ($problem in $problems) { Write-Host "  - $problem" -ForegroundColor Yellow }
exit 1
