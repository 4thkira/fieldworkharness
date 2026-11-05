@echo off
rem Save a hosted-model API key without putting it in a command argument or file.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\set-api-key.ps1"
if errorlevel 1 (pause & exit /b 1)
pause
