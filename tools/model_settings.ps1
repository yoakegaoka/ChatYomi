# ChatYomi 専用のローカル設定。Server 側の .env は変更しない。
$script:DefaultIrodoriCheckpoint = 'Aratako/Irodori-TTS-500M-v3'
$script:LocalSettingsPath = Join-Path (Split-Path -Parent $PSScriptRoot) '.local\settings.json'

function Read-LocalSettings {
    if (-not (Test-Path -LiteralPath $script:LocalSettingsPath -PathType Leaf)) { return @{} }
    try {
        $saved = Get-Content -LiteralPath $script:LocalSettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $data = @{}
        foreach ($property in $saved.PSObject.Properties) { $data[$property.Name] = $property.Value }
        return $data
    }
    catch { throw '.local/settings.json を読み取れない。内容を確認してから再実行してください。' }
}

function Write-LocalSettings {
    param([hashtable]$Data)
    $directory = Split-Path -Parent $script:LocalSettingsPath
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        New-Item -ItemType Directory -Path $directory | Out-Null
    }
    $json = $Data | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($script:LocalSettingsPath, $json + [Environment]::NewLine,
        (New-Object Text.UTF8Encoding($false)))
}

function Get-SelectedIrodoriCheckpoint {
    param([hashtable]$Settings)
    $selected = [string]$Settings.irodoriCheckpoint
    if ($selected) { return $selected }
    return $script:DefaultIrodoriCheckpoint
}

function Save-SelectedIrodoriCheckpoint {
    param([string]$Checkpoint)
    $settings = Read-LocalSettings
    $history = @($Checkpoint)
    foreach ($item in @($settings.recentIrodoriCheckpoints)) {
        $previous = [string]$item
        if ($previous -and $previous -ne $Checkpoint -and $history.Count -lt 6) {
            $history += $previous
        }
    }
    $settings.irodoriCheckpoint = $Checkpoint
    $settings.recentIrodoriCheckpoints = $history
    Write-LocalSettings -Data $settings
}
