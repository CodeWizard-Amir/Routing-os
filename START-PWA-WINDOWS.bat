@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo  Routine OS - Production / PWA Launcher
echo ============================================
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20.9 or newer was not found.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies for the first run...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)
echo Building the installable PWA...
call npm run start:pwa
if errorlevel 1 (
  echo Build or startup failed. Review the error above.
  pause
  exit /b 1
)
pause
