@echo off
setlocal
cd /d "%~dp0"
title ChatYomi - Select model

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0select_model.ps1"
if errorlevel 1 (
  echo.
  echo Model selection failed. Review the messages above.
  pause
)
