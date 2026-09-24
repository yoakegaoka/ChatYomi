@echo off
setlocal
cd /d "%~dp0"
title Irodori TTS Reader

start "" powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0tools\open_admin_when_ready.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_server.ps1" %*

if errorlevel 1 (
  echo.
  echo Startup failed. Review the messages above.
  echo See docs\troubleshooting-windows.md if you need help.
  pause
)
