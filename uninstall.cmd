@echo off
setlocal
cd /d "%~dp0"
title Irodori TTS Reader - Uninstall

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
if errorlevel 1 (
  echo.
  echo Uninstall helper failed. Review the messages above.
)
pause
