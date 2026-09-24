@echo off
setlocal
cd /d "%~dp0"
title Irodori TTS Reader - Initial Setup

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Interactive
if errorlevel 1 (
  echo.
  echo Setup did not finish. Review the messages above.
  echo See docs\troubleshooting-windows.md if you need help.
  pause
  exit /b 1
)

echo.
echo Setup finished. Double-click start.cmd to start the reader.
pause
