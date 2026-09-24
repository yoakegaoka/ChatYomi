# Irodori TTS Reader のアンインストール補助。
# 本ソフトのプロセスを停止する。最後のフォルダー削除は利用者が行う。

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host ''
Write-Host 'Irodori TTS Reader アンインストール補助' -ForegroundColor Cyan
Write-Host ''

& (Join-Path $PSScriptRoot 'stop_server.ps1')

Write-Host ''
Write-Host '残りの手順:' -ForegroundColor Cyan
Write-Host '  1. Violentmonkey/Tampermonkeyから本userscriptを削除する。'
Write-Host '  2. LAN用ファイアウォール規則を追加した場合だけ削除する。'
Write-Host '  3. このウィンドウを閉じ、このプロジェクトフォルダーを削除する。'
Write-Host ''
Write-Host 'Python、uv、Irodori-TTS-Server、モデルキャッシュは共有される可能性があるため削除しない。' -ForegroundColor DarkGray
