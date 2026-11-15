@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo Routine OS - Background Push dependencies
echo ============================================
echo.
if not exist package.json (
  echo ERROR: package.json was not found. Run this file from the Routine OS project root.
  pause
  exit /b 1
)
call npm install
if errorlevel 1 (
  echo.
  echo npm install failed. Check your internet connection and Node.js/npm installation.
  pause
  exit /b 1
)
echo.
echo Dependencies installed successfully.
echo Next: configure Vercel Environment Variables using README_PUSH_FA.md,
echo then redeploy and enable notifications from the app Settings.
echo.
pause
