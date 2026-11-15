@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo  Routine OS - Local Development Launcher
echo ============================================
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20.9 or newer first.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing project dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)
echo Starting Routine OS at http://localhost:3000
call npm run dev
pause
