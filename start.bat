@echo off
cd /d "%~dp0"
echo Starting Dex Art Card Tracker. The first time this takes a few minutes...
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo Something went wrong. Is Docker Desktop installed and running?
  pause
  exit /b 1
)
start http://localhost:8080
echo.
echo Running. Open http://localhost:8080 in your browser. You can close this window.
pause
