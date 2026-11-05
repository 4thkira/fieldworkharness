@echo off
setlocal
set "ERRORLEVEL="
rem Double-click to start Fieldwork. The first start asks a few questions.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missing_node
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto old_node
node scripts\prepare-dependencies-cli.mjs
if errorlevel 1 goto failed
node scripts\start.mjs
if errorlevel 1 goto failed
exit /b 0

:missing_node
echo Fieldwork needs Node.js 22 or newer: https://nodejs.org
pause
exit /b 1

:old_node
echo Fieldwork needs Node.js 22 or newer: https://nodejs.org
node --version
pause
exit /b 1

:failed
set "FIELDWORK_EXIT=%errorlevel%"
pause
exit /b %FIELDWORK_EXIT%
