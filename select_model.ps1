# ダブルクリックで任意の Hugging Face チェックポイントを選んで起動する。
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
. (Join-Path $PSScriptRoot 'tools\model_settings.ps1')

function Get-ListenerProcess {
    param([int]$Port)
    try {
        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($listener) { return Get-Process -Id $listener.OwningProcess -ErrorAction Stop }
    }
    catch { }
    return $null
}

function Test-OwnedIrodoriServer {
    param($Process)
    if (-not $Process) { return $false }
    $pidFile = Join-Path $PSScriptRoot '.local\irodori-server.pid'
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { return $false }
    $expected = "$($Process.Id)|$($Process.StartTime.ToUniversalTime().Ticks)"
    return (Get-Content -LiteralPath $pidFile -Raw).Trim() -eq $expected
}

function Test-HfCheckpointId {
    param([string]$Id)
    if ($Id -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*(/[A-Za-z0-9][A-Za-z0-9_.-]*)*$') {
        return $false
    }
    foreach ($segment in $Id.Split('/')) {
        if ($segment -eq '.' -or $segment -eq '..') { return $false }
    }
    return $true
}

try {
    $settings = Read-LocalSettings
    $current = Get-SelectedIrodoriCheckpoint -Settings $settings
    $options = New-Object System.Collections.Generic.List[string]
    foreach ($candidate in @($current) + @($settings.recentIrodoriCheckpoints) + @(
        'Aratako/Irodori-TTS-500M-v3',
        'Aratako/Irodori-TTS-v4-Large-Quantized/int8-weight-only')) {
        $id = [string]$candidate
        if ($id -and -not $options.Contains($id)) { $options.Add($id) }
    }

    Write-Host "現在の選択: $current"
    Write-Host '使うモデルを選んでください。Irodori-TTS-Server対応のチェックポイントIDも入力できます。'
    for ($i = 0; $i -lt $options.Count; $i++) {
        Write-Host "[$($i + 1)] $($options[$i])"
    }
    Write-Host '[N] 新しいモデルIDを入力'
    Write-Host '[Q] キャンセル'
    $choice = (Read-Host '番号または N/Q').Trim()
    if ($choice -match '^[Qq]$') { exit 0 }
    if ($choice -match '^[Nn]$') {
        $selected = (Read-Host 'Hugging Face のモデルID（例: Aratako/Irodori-TTS-v4.1-Small）').Trim()
    }
    else {
        $number = 0
        if (-not [int]::TryParse($choice, [ref]$number) -or $number -lt 1 -or $number -gt $options.Count) {
            throw '一覧の番号、N、Q のいずれかを入力してください。'
        }
        $selected = $options[$number - 1]
    }
    if (-not (Test-HfCheckpointId -Id $selected)) {
        throw 'Hugging Face のモデルIDまたはリポジトリ内サブフォルダーを指定してください（例: Aratako/Irodori-TTS-v4.1-Small）。'
    }
    if ($selected -eq 'Aratako/Irodori-TTS-v4-Large-Quantized/int8-weight-only') {
        Write-Host 'v4-Large量子化版にはGemmaの利用条件が適用されます。公開元のモデルカードを確認してください。' -ForegroundColor Yellow
        Write-Host 'https://huggingface.co/Aratako/Irodori-TTS-v4-Large-Quantized'
    }
    elseif ($selected -ne 'Aratako/Irodori-TTS-500M-v3') {
        Write-Host '選んだモデルの対応環境と利用条件を公開元で確認してください。' -ForegroundColor Yellow
    }

    $serverProcess = Get-ListenerProcess -Port 8088
    $wrapperProcess = Get-ListenerProcess -Port 8080
    if ($serverProcess) {
        try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8088/health' -TimeoutSec 2 }
        catch { throw ':8088 で応答中のプロセスがあるため、モデルを切り替えられません。' }
        if ($health.model.hf_checkpoint -eq $selected -and $health.runtime.loaded) {
            Save-SelectedIrodoriCheckpoint -Checkpoint $selected
            Write-Host "選択を保存しました。起動中のモデルも $selected です。" -ForegroundColor Green
            if ($wrapperProcess) { exit 0 }
        }
        elseif (-not (Test-OwnedIrodoriServer -Process $serverProcess)) {
            throw 'Irodori-TTS-Server はChatYomi以外から起動されています。停止してから選び直してください。選択は変更していません。'
        }
    }
    if ($wrapperProcess -and (-not $serverProcess -or -not (Test-OwnedIrodoriServer -Process $serverProcess))) {
        throw ':8080 でChatYomiが動いています。stop.cmd で停止してから選び直してください。選択は変更していません。'
    }
    if ($wrapperProcess) {
        try { $wrapperHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 2 }
        catch { throw ':8080 で別のプロセスが動いています。停止してから選び直してください。' }
        if ($wrapperHealth.backend -ne 'irodori_server') {
            throw ':8080 で別のプロセスが動いています。停止してから選び直してください。'
        }
    }
    if ($serverProcess -or $wrapperProcess) {
        Write-Host '起動中のChatYomiを停止してモデルを切り替えます。'
        & (Join-Path $PSScriptRoot 'stop_server.ps1')
        if ((Get-ListenerProcess -Port 8080) -or (Get-ListenerProcess -Port 8088)) {
            throw '停止できませんでした。選択は変更していません。'
        }
    }

    Write-Host "起動するモデル: $selected"
    $opener = Join-Path $PSScriptRoot 'tools\open_admin_when_ready.ps1'
    Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$opener`"" -WindowStyle Hidden
    & (Join-Path $PSScriptRoot 'run_server.ps1') -IrodoriCheckpoint $selected -SaveCheckpointOnReady
}
catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
