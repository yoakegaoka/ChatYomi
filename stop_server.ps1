# Irodori TTS Reader と Irodori-TTS-Server の停止
#
# 使い方:
#   .\stop_server.ps1              ラッパー(:8080) とServer(:8088)を止める
#   .\stop_server.ps1 -Force       応答しないラッパーを強制終了する
#   .\stop_server.ps1 -Port 8099   検証用ラッパーだけを止める

param(
    [switch]$Force,
    [int]$Port = 8080,
    [int]$IrodoriServerPort = 8088
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Get-ListenerProcess {
    param([int]$TargetPort)
    try {
        $conn = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction Stop | Select-Object -First 1
    }
    catch { return $null }
    if (-not $conn) { return $null }
    try { return Get-Process -Id $conn.OwningProcess -ErrorAction Stop }
    catch { return $null }
}

function Wait-PortClosed {
    param([int]$TargetPort, [int]$TimeoutSec = 10)
    for ($i = 0; $i -lt ($TimeoutSec * 2); $i++) {
        if (-not (Get-ListenerProcess -TargetPort $TargetPort)) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

$proc = Get-ListenerProcess -TargetPort $Port
if (-not $proc) {
    Write-Host ":$Port は動いていない" -ForegroundColor Yellow
}
else {
    Write-Host ":$Port を停止する (PID $($proc.Id) $($proc.ProcessName))"
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/admin/shutdown" -Method Post -TimeoutSec 5 | Out-Null }
    catch { Write-Host '  停止要求の応答は返らなかった（想定内）' -ForegroundColor DarkGray }

    if (Wait-PortClosed -TargetPort $Port) {
        Write-Host '  停止した' -ForegroundColor Green
    }
    elseif ($Force) {
        $still = Get-ListenerProcess -TargetPort $Port
        if ($still -and $still.ProcessName -match 'python') {
            Write-Host "  応答しないので強制終了する (PID $($still.Id))" -ForegroundColor Yellow
            Stop-Process -Id $still.Id -Force
            if (Wait-PortClosed -TargetPort $Port -TimeoutSec 5) { Write-Host '  停止した' -ForegroundColor Green }
            else { Write-Host '  停止できなかった' -ForegroundColor Red }
        }
        elseif ($still) { Write-Host "  :$Port は $($still.ProcessName) が使っている。想定と違うので何もしない" -ForegroundColor Red }
    }
    else { Write-Host '  停止しない。-Force を付けると強制終了する' -ForegroundColor Red }
}

# 既定ポートの通常停止では、同時起動したIrodori-TTS-Serverも止める。
# -Portを使うDummy検証ではServerに触れない。
if ($Port -eq 8080) {
    $pidFile = Join-Path $PSScriptRoot '.local\irodori-server.pid'
    $serverProc = Get-ListenerProcess -TargetPort $IrodoriServerPort
    $ownedServer = $false
    if ($serverProc -and (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
        $expected = "$($serverProc.Id)|$($serverProc.StartTime.ToUniversalTime().Ticks)"
        $ownedServer = (Get-Content -LiteralPath $pidFile -Raw).Trim() -eq $expected
    }
    if (-not $serverProc) {
        Write-Host ":$IrodoriServerPort は動いていない" -ForegroundColor Yellow
        Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
    }
    elseif ($serverProc.ProcessName -notmatch 'python') {
        Write-Host ":$IrodoriServerPort は $($serverProc.ProcessName) が使っている。想定と違うので何もしない" -ForegroundColor Red
    }
    elseif (-not $ownedServer) {
        Write-Host ":$IrodoriServerPort はChatYomi以外が起動したServerなので停止しない" -ForegroundColor Yellow
    }
    else {
        Write-Host ":$IrodoriServerPort を停止する (PID $($serverProc.Id) $($serverProc.ProcessName))"
        Stop-Process -Id $serverProc.Id -Force
        if (Wait-PortClosed -TargetPort $IrodoriServerPort) { Write-Host '  停止した' -ForegroundColor Green }
        else { Write-Host '  停止できなかった' -ForegroundColor Red }
        Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
    }
}

Write-Host ''
Write-Host '起動しなおすには .\run_server.ps1'
