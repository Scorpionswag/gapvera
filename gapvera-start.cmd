@echo off
title GapVera
rem Runs from wherever this file lives, so the folder can go anywhere.
cd /d "%~dp0"

rem If GapVera is already running, just open it instead of starting a second copy.
netstat -ano | findstr /c:":3001 " | findstr LISTENING >nul
if %errorlevel%==0 (
  echo GapVera is already running - opening it.
  start http://localhost:5173
  timeout /t 3 /nobreak >nul
  exit
)

if not exist "node_modules" (
  echo First run: installing dependencies. This takes a minute or two.
  call npm install
)

echo Starting GapVera... your browser opens in a few seconds.
echo Keep this window open while you work. Closing it shuts GapVera down.
start /b cmd /c "timeout /t 6 /nobreak >nul & start http://localhost:5173"
npm run dev
