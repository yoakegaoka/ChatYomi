@echo off
setlocal
cd /d "%~dp0"
title Irodori TTS Reader - Stop

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop_server.ps1"
if errorlevel 1 (
  echo.
  echo Stop failed. Review the messages above.
  pause
  exit /b 1
)

echo.
echo The reader has stopped.
timeout /t 2 /nobreak >nul
