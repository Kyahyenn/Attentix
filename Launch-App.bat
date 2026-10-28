@echo off
rem Attentix - double-click to start (shows a console window; use Launch-Silent.vbs for none).
setlocal
cd /d "%~dp0"
title Attentix

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is needed to run from source: https://nodejs.org
  echo Or double-click Attentix-win.exe, which needs nothing installed.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing the components this app needs. This needs internet and takes a minute...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo The install failed. Check your internet connection and run this file again.
    pause
    exit /b 1
  )
)

rem The server opens your browser by itself, creates its settings on first run and prints the address for students.
node src\index.js
echo.
echo The server has stopped.
pause
